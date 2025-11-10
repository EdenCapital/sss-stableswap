use candid::CandidType;
use serde::{Serialize, Deserialize};

use crate::{
    types::{
        Account, AmountE6, TokenId, PoolInfo, QuoteOut, SwapArgs, SubBalance, Position, Available,
        StatsSnapshot, RiskParams, CyclesInfo,
    },
    assets, explore, swap as swap_mod, positions, events::{self, Event},
};

use ic_cdk::query;
use ic_cdk::api::canister_balance128;
use ic_cdk::api::call::call as ic_call;

use crate::state::{STATE, now, skey};
use crate::math::stableswap;
use num_traits::cast::ToPrimitive;                   // 若缺少请添加



use crate::icrc::{pool_account, derive_subaccount, icrc1_balance_of, canister_principal};
use candid::{Nat, Principal};



/* ---------------- 代币元信息（对外 Nat 口径；内部统一 e6） ---------------- */

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TokenMeta {
    pub ckusdc: Principal,
    pub ckusdt: Principal,
    pub dec_usdc: u8,
    pub dec_usdt: u8,
}

/* ---------------- 数值换算工具：外部 decimals ↔ 内部 e6 ---------------- */

// === 预计算：根据池状态，确定 add 实际扣款与铸造份额（全部 e6 口径） ===
fn compute_add_use_amounts(req_usdc_e6: u128, req_usdt_e6: u128) -> (u128, u128, u128) {
    STATE.with(|s| {
        let st = s.borrow();
        let ru = st.pool.reserve_usdc;
        let rv = st.pool.reserve_usdt;
        let ts = st.pool.total_shares;

        // 首次建池或任一侧为 0：按请求全额入池（演示/PoC 场景下最直观）
        if ts == 0 || ru == 0 || rv == 0 {
            let mint = req_usdc_e6.saturating_add(req_usdt_e6);
            return (req_usdc_e6, req_usdt_e6, mint);
        }

        // 常规：按最小可铸份额 min(s1, s2) 决定“实际扣款”
        let s1   = req_usdc_e6.saturating_mul(ts) / ru;
        let s2   = req_usdt_e6.saturating_mul(ts) / rv;
        let mint = s1.min(s2);
        if mint == 0 {
            return (0, 0, 0);
        }
        let use_u = mint.saturating_mul(ru) / ts;
        let use_v = mint.saturating_mul(rv) / ts;
        (use_u, use_v, mint)
    })
}

// ------------------- 工具：ext(Nat) -> e6(u128) -------------------
fn ext_to_e6(n: &Nat, decimals: u8) -> u128 {
    let raw = n.0.to_u128().unwrap_or(0);
    if decimals == 6 {
        raw
    } else if decimals < 6 {
        raw.saturating_mul(10u128.pow((6 - decimals) as u32))
    } else {
        raw / 10u128.pow((decimals - 6) as u32)
    }
}


fn pow10u(n: u32) -> u128 { 10u128.saturating_pow(n) }

fn nat_to_u128(n: &Nat) -> u128 {
    if let Some(v) = n.0.to_u128() { return v; }
    let s = n.to_string().replace('_', "");
    s.parse::<u128>().unwrap_or(0u128)
}

fn u128_to_nat(x: u128) -> Nat { Nat::from(x) }

/// 外部单位（decimals=dec）→ 内部 e6（向下取整，保守）
fn ext_to_int_e6(amount_ext: &Nat, dec: u8) -> u128 {
    let x = nat_to_u128(amount_ext);
    if dec >= 6 {
        let k = pow10u((dec - 6) as u32);
        x / k
    } else {
        let k = pow10u((6 - dec) as u32);
        x.saturating_mul(k)
    }
}

/// 内部 e6 → 外部单位（Nat，跟随各自 decimals）
fn int_e6_to_ext(amount_e6: u128, dec: u8) -> Nat {
    if dec >= 6 {
        let k = pow10u((dec - 6) as u32);
        u128_to_nat(amount_e6.saturating_mul(k))
    } else {
        let k = pow10u((6 - dec) as u32);
        u128_to_nat(amount_e6 / k)
    }
}

/* ---------------- 代币元信息的设置/读取 ---------------- */

#[ic_cdk::update]
pub fn set_token_meta(meta: TokenMeta) {
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.ckusdc = Some(meta.ckusdc);
        st.ckusdt = Some(meta.ckusdt);
        st.dec_usdc = Some(meta.dec_usdc);
        st.dec_usdt = Some(meta.dec_usdt);
    });
}

#[ic_cdk::query]
pub fn get_token_meta() -> Option<TokenMeta> {
    STATE.with(|s| {
        let st = s.borrow();
        match (st.ckusdc, st.ckusdt, st.dec_usdc, st.dec_usdt) {
            (Some(u), Some(t), Some(du), Some(dt)) => Some(TokenMeta {
                ckusdc: u, ckusdt: t, dec_usdc: du, dec_usdt: dt
            }),
            _ => None,
        }
    })
}

/// 返回池子的 ICRC 账户（owner=本 canister；sub=固定 POOL_SUB）
/// 入参 token_id_or_symbol 目前仅占位，保留未来多池/多路由扩展空间
#[ic_cdk::query]
pub fn get_pool_account(_token_id_or_symbol: String) -> Account {
    // Phase A 仅返回固定池子账户，参数先占位以便未来多池扩展
    pool_account()
}

// ========== 新增：池子实时储备（直读两条 ICRC-1 账本，返回外部最小单位 Nat） ==========
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct PoolReserves {
    pub usdc: Nat,
    pub usdt: Nat,
}

// 说明：此方法为“复合查询”，内部调用其他 canister 的 query（icrc1_balance_of）
#[ic_cdk::query(composite = true)]
pub async fn get_pool_reserves_live() -> PoolReserves {
    // 原逻辑：尝试跨 canister 读取
    let (ckusdc, ckusdt, du, dt) = STATE.with(|s| {
        let st = s.borrow();
        (st.ckusdc, st.ckusdt, st.dec_usdc, st.dec_usdt)
    });
    let (ckusdc, ckusdt, du, dt) = match (ckusdc, ckusdt, du, dt) {
        (Some(u), Some(t), Some(du), Some(dt)) => (u, t, du, dt),
        _ => {
            // 元信息未设置：直接回退 internal
            return STATE.with(|s| {
                let st = s.borrow();
                PoolReserves {
                    usdc: int_e6_to_ext(st.pool.reserve_usdc, st.dec_usdc.unwrap_or(6)),
                    usdt: int_e6_to_ext(st.pool.reserve_usdt, st.dec_usdt.unwrap_or(6)),
                }
            });
        }
    };

    let acc = pool_account();
    let (u_res, t_res) = futures::future::join(
        icrc1_balance_of(ckusdc, acc.clone()),
        icrc1_balance_of(ckusdt, acc.clone()),
    ).await;

    match (u_res, t_res) {
        (Ok(u_nat), Ok(t_nat)) => PoolReserves { usdc: u_nat, usdt: t_nat },
        // ★ 失败兜底：返回 internal 储备（转为外部单位），避免 (0,0)
        _ => STATE.with(|s| {
            let st = s.borrow();
            PoolReserves {
                usdc: int_e6_to_ext(st.pool.reserve_usdc, du),
                usdt: int_e6_to_ext(st.pool.reserve_usdt, dt),
            }
        }),
    }
}


/// 管理员：从 Ledger 实时余额对齐内部池储备，并写回 state.pool.* （单位：e6）
#[ic_cdk::update]
pub async fn admin_reconcile_pool_from_live() -> TextResult {
    // 1) 读取 token meta
    let meta = match get_token_meta() {
        Some(m) => m,
        None => return TextResult::Err("token meta not set".into()),
    };

    // 2) 读取 POOL 子账户的 live 余额
    let pool_acct = get_pool_account("USDC_USDT".to_string());
    let (bal_u_res, bal_v_res) = futures::future::join(
        icrc1_balance_of(meta.ckusdc, pool_acct.clone()),
        icrc1_balance_of(meta.ckusdt, pool_acct.clone()),
    ).await;

    let bal_u = match bal_u_res {
        Ok(n) => n,
        Err(e) => return TextResult::Err(format!("ckUSDC balance err: {e}")),
    };
    let bal_v = match bal_v_res {
        Ok(n) => n,
        Err(e) => return TextResult::Err(format!("ckUSDT balance err: {e}")),
    };

    // 3) 外部最小单位 -> 内部 e6，并计算 new_total
    let usdc_e6 = ext_to_e6(&bal_u, meta.dec_usdc);
    let usdt_e6 = ext_to_e6(&bal_v, meta.dec_usdt);
    let new_total = usdc_e6.saturating_add(usdt_e6);

    // ★ 4) 先按“旧 total_shares”把 user_shares 等比缩放到 new_total（函数内部会写回 total_shares=new_total）
    positions::admin_rescale_all_shares(new_total);

    // ★ 5) 再写回池子的 internal 储备（避免覆盖上一步已设置的 total_shares）
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.pool.reserve_usdc = usdc_e6;
        st.pool.reserve_usdt = usdt_e6;
    });

    TextResult::Ok(format!(
        "ok: live_e6 {{usdc:{}, usdt:{}}}, total_shares={}",
        usdc_e6, usdt_e6, new_total
    ))
}

#[ic_cdk::update]
pub fn admin_reconcile_from_internal() -> TextResult {
    // 按当前 internal 储备计算 total，并对 LP 份额做等比缩放
    let (u, v) = STATE.with(|s| {
        let st = s.borrow();
        (st.pool.reserve_usdc, st.pool.reserve_usdt)
    });
    let new_total = u.saturating_add(v);
    positions::admin_rescale_all_shares(new_total);
    TextResult::Ok(format!("ok: internal_e6 total_shares={}", new_total))
}



/* ---------------- 通用 Result ---------------- */

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum TextResult {
    #[serde(rename = "ok")] Ok(String),
    #[serde(rename = "err")] Err(String),
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum TxResultNat {
    #[serde(rename = "ok")]  Ok(Nat),
    #[serde(rename = "err")] Err(String),
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum PositionResult {
    #[serde(rename = "ok")] Ok(Position),
    #[serde(rename = "err")] Err(String),
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TwoAmounts { pub usdc: AmountE6, pub usdt: AmountE6 }

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum TwoAmountsResult {
    #[serde(rename = "ok")] Ok(TwoAmounts),
    #[serde(rename = "err")] Err(String),
}

fn err<T>(e: impl core::fmt::Debug) -> std::result::Result<T, String> {
    Err(format!("{:?}", e))
}

/* ---------------- Assets（保留：资产页依赖） ---------------- */

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct UserBalances {
    pub usdc: AmountE6,
    pub usdt: AmountE6,
    pub bob:  AmountE6,
    pub icp:  AmountE6,
}

/// 资产页：返回“main 子账户”的内账 e6 余额（演示阶段口径）
#[query]
pub fn get_user_balances(account: Account)
 -> (AmountE6, AmountE6, AmountE6, AmountE6) /* usdc,usdt,bob,icp */
{
    STATE.with(|s| {
        let st = s.borrow();
        let key = skey(&account.owner);
        let usdc = *st.user_sub_usdc.get(&key).unwrap_or(&0);
        let usdt = *st.user_sub_usdt.get(&key).unwrap_or(&0);
        (usdc, usdt, 0u128, 0u128)
    })
}

/// 资产页：子账户余额明细（保留）
#[ic_cdk::query]
pub fn get_user_sub_balances(account: Account) -> Vec<SubBalance> {
    assets::get_user_sub_balances(&account)
}

/* ---------------- Explore ---------------- */

#[ic_cdk::query]
pub fn get_pool_info() -> PoolInfo { explore::get_pool_info() }

/// 演示/灌池入口 —— 为避免线上干扰，这里改为“无副作用”的空实现：返回当前池信息，不再改写任何状态。
#[ic_cdk::update]
pub fn seed_pool_demo(_usdc: AmountE6, _usdt: AmountE6) -> PoolInfo {
    ic_cdk::print("[seed_pool_demo] disabled in prod: no-op");
    explore::get_pool_info()
}
/* ---------------- Swap ---------------- */

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct SwapOk { pub dy_e6: AmountE6 }

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum StdResultSwap {
    #[serde(rename = "ok")] Ok(SwapOk),
    #[serde(rename = "err")] Err(String),
}

#[ic_cdk::query]
pub fn quote(token_in: TokenId, token_out: TokenId, dx_e6: AmountE6) -> QuoteOut {
    swap_mod::quote(token_in, token_out, dx_e6)
}

#[ic_cdk::update]
pub fn swap(args: SwapArgs) -> StdResultSwap {
    match swap_mod::swap(args) {
        Ok(big) => {
            let n = big.to_u128().unwrap_or(0);
            StdResultSwap::Ok(SwapOk { dy_e6: n })
        }
        Err(e) => StdResultSwap::Err(format!("{e:?}")),
    }
}

/* ---------------- Liquidity ---------------- */

#[ic_cdk::query]
pub fn get_user_position(account: Account) -> Position {
    let shares = positions::get_user_position(account);
    Position { shares }
}

/// 只读预览：可领取手续费
#[ic_cdk::query]
pub fn get_unclaimed_fee(account: Account) -> TwoAmounts {
    match positions::preview_claim_fee(account) {
        Ok((u, v)) => TwoAmounts { usdc: u, usdt: v },
        Err(_)     => TwoAmounts { usdc: 0, usdt: 0 },
    }
}

#[ic_cdk::update]
pub async fn add_liquidity(account: Account, usdc: AmountE6, usdt: AmountE6) -> PositionResult {
    // 1) 依据池状态计算实际扣款（多的一侧不扣）
    let (use_u_e6, use_v_e6, _mint) = compute_add_use_amounts(usdc, usdt);
    if use_u_e6 == 0 && use_v_e6 == 0 {
        return PositionResult::Err("amount too small".into());
    }

    // 2) 取元信息与账户
    let (ckusdc, ckusdt, du, dt) = STATE.with(|s| {
        let st = s.borrow();
        (st.ckusdc, st.ckusdt, st.dec_usdc, st.dec_usdt)
    });
    let (ckusdc, ckusdt, du, dt) = match (ckusdc, ckusdt, du, dt) {
        (Some(a), Some(b), Some(du), Some(dt)) => (a, b, du, dt),
        _ => return PositionResult::Err("token meta not set".into()),
    };

    let pool_acc = get_pool_account("USDC_USDT".to_string());
    let user_sub = derive_subaccount(account.owner).to_vec();
    let from_user = Some(user_sub.clone());

    // 3) 先执行实际扣款的链上转账：用户子 → 池子子
    if use_u_e6 > 0 {
        let arg_u = Icrc1TransferArg {
            from_subaccount: from_user.clone(),
            to: pool_acc.clone(),
            amount: int_e6_to_ext(use_u_e6, du),
            fee: None, memo: None, created_at_time: None,
        };
        if let Err(e) = do_icrc1_transfer(ckusdc, arg_u).await {
            return PositionResult::Err(format!("ckUSDC transfer failed: {e}"));
        }
    }
    if use_v_e6 > 0 {
        let arg_v = Icrc1TransferArg {
            from_subaccount: from_user.clone(),
            to: pool_acc.clone(),
            amount: int_e6_to_ext(use_v_e6, dt),
            fee: None, memo: None, created_at_time: None,
        };
        if let Err(e) = do_icrc1_transfer(ckusdt, arg_v).await {
            // 回滚已成功的 USDC 扣款（尽力而为）
            if use_u_e6 > 0 {
                let back_to_user = Account {
                    owner: canister_principal(),
                    subaccount: Some(user_sub.clone()),
                };
                let _ = do_icrc1_transfer(
                    ckusdc,
                    Icrc1TransferArg {
                        from_subaccount: pool_acc.subaccount.clone(),
                        to: back_to_user,
                        amount: int_e6_to_ext(use_u_e6, du),
                        fee: None, memo: None, created_at_time: None,
                    },
                ).await;
            }
            return PositionResult::Err(format!("ckUSDT transfer failed: {e}"));
        }
    }

    // 4) 铸造 shares（内部账本）
    match positions::add_liquidity(account.clone(), use_u_e6, use_v_e6) {
        Ok(shares) => {
            // 异步刷新可用额缓存（不阻塞本次返回）
            ic_cdk::spawn(async move { let _ = do_refresh_available_for(account.owner).await; });
            let who = format!("{}", account.owner.to_text());
            events::push(Event::AddLiq { who, usdc: use_u_e6, usdt: use_v_e6, shares, ts: now() });
            PositionResult::Ok(Position { shares })
        }
        Err(e) => {
            // 内部失败则回滚链上扣款（尽力而为）
            let back_to_user = Account {
                owner: canister_principal(),
                subaccount: Some(user_sub.clone()),
            };
            if use_u_e6 > 0 {
                let _ = do_icrc1_transfer(
                    ckusdc,
                    Icrc1TransferArg {
                        from_subaccount: pool_acc.subaccount.clone(),
                        to: back_to_user.clone(),
                        amount: int_e6_to_ext(use_u_e6, du),
                        fee: None, memo: None, created_at_time: None,
                    },
                ).await;
            }
            if use_v_e6 > 0 {
                let _ = do_icrc1_transfer(
                    ckusdt,
                    Icrc1TransferArg {
                        from_subaccount: pool_acc.subaccount.clone(),
                        to: back_to_user,
                        amount: int_e6_to_ext(use_v_e6, dt),
                        fee: None, memo: None, created_at_time: None,
                    },
                ).await;
            }
            PositionResult::Err(format!("{:?}", e))
        }
    }
}


#[ic_cdk::update]
pub async fn remove_liquidity(account: Account, shares: AmountE6) -> TwoAmountsResult {
    if shares == 0 {
        return TwoAmountsResult::Err("shares is zero".into());
    }

    // 1) 先按内部规则扣减 shares，得到应退 ckUSDC/ckUSDT（均 e6 口径）
    let (out_u_e6, out_v_e6) = match positions::remove_liquidity(account.clone(), shares) {
        Ok((u, v)) => (u, v),
        Err(e) => return TwoAmountsResult::Err(format!("{:?}", e)),
    };

    // 2) 元信息 / 账户
    let (ckusdc, ckusdt, du, dt) = STATE.with(|s| {
        let st = s.borrow();
        (st.ckusdc, st.ckusdt, st.dec_usdc, st.dec_usdt)
    });
    let (ckusdc, ckusdt, du, dt) = match (ckusdc, ckusdt, du, dt) {
        (Some(a), Some(b), Some(du), Some(dt)) => (a, b, du, dt),
        _ => return TwoAmountsResult::Err("token meta not set".into()),
    };

    let pool_acc = get_pool_account("USDC_USDT".to_string());
    let user_sub = derive_subaccount(account.owner).to_vec();
    let to_user = Account { owner: canister_principal(), subaccount: Some(user_sub.clone()) };

    // 3) 链上实际转回：池子子 → 用户子
    // 先转 ckUSDC
    if out_u_e6 > 0 {
        let arg_u = Icrc1TransferArg {
            from_subaccount: pool_acc.subaccount.clone(),
            to: to_user.clone(),
            amount: int_e6_to_ext(out_u_e6, du),
            fee: None, memo: None, created_at_time: None,
        };
        if let Err(e) = do_icrc1_transfer(ckusdc, arg_u).await {
            // 回滚 shares（把刚刚的 remove 复原）
            let _ = positions::add_liquidity(account.clone(), out_u_e6, out_v_e6);
            return TwoAmountsResult::Err(format!("ckUSDC transfer back failed: {e}"));
        }
    }
    // 再转 ckUSDT
    if out_v_e6 > 0 {
        let arg_v = Icrc1TransferArg {
            from_subaccount: pool_acc.subaccount.clone(),
            to: to_user.clone(),
            amount: int_e6_to_ext(out_v_e6, dt),
            fee: None, memo: None, created_at_time: None,
        };
        if let Err(e) = do_icrc1_transfer(ckusdt, arg_v).await {
            // 尝试把已转出的 USDC 挪回池子、并复原 shares（尽力而为）
            if out_u_e6 > 0 {
                let _ = do_icrc1_transfer(
                    ckusdc,
                    Icrc1TransferArg {
                        from_subaccount: to_user.subaccount.clone(),
                        to: pool_acc.clone(),
                        amount: int_e6_to_ext(out_u_e6, du),
                        fee: None, memo: None, created_at_time: None,
                    },
                ).await;
            }
            let _ = positions::add_liquidity(account.clone(), out_u_e6, out_v_e6);
            let who = format!("{}", account.owner.to_text());
            events::push(Event::RemoveLiq { who, shares, usdc: out_u_e6, usdt: out_v_e6, ts: now() });

            return TwoAmountsResult::Err(format!("ckUSDT transfer back failed: {e}"));
        }
    }

    // 4) 刷新 live 可用额度缓存（异步）
    ic_cdk::spawn(async move { let _ = do_refresh_available_for(account.owner).await; });

    TwoAmountsResult::Ok(TwoAmounts { usdc: out_u_e6, usdt: out_v_e6 })
}


// ------------------- 真实发币的 Claim Fee（POOL → 用户子账户） -------------------
#[ic_cdk::update]
pub async fn claim_fee(acct: Account) -> Result<(AmountE6, AmountE6), String> {
    // 0) 预览可领取（e6）——注意 preview_claim_fee 返回 Result
    let (usdc_e6, usdt_e6) = positions::preview_claim_fee(acct.clone())
        .map_err(|e| format!("{:?}", e))?;

    if usdc_e6 == 0 && usdt_e6 == 0 {
        return Ok((0, 0));
    }

    // 1) 读取 meta 与账户
    let meta = get_token_meta().ok_or("token meta not set")?;
    let from_pool = pool_account();

    // 注意：你的架构中“用户子账户”实际是 canister 作为 owner、sub 为 derive(user)
    // 保持与 remove_liquidity 中 to_user 的口径一致，避免账户体系混乱
    let to_user = Account {
        owner: canister_principal(),
        subaccount: Some(derive_subaccount(acct.owner).to_vec()),
    };

    // 2) 余额校验（live），避免半成功
    let bal_u = icrc1_balance_of(meta.ckusdc, from_pool.clone())
        .await.map_err(|e| format!("ckUSDC balance err: {e}"))?;
    let bal_v = icrc1_balance_of(meta.ckusdt, from_pool.clone())
        .await.map_err(|e| format!("ckUSDT balance err: {e}"))?;
    if ext_to_e6(&bal_u, meta.dec_usdc) < usdc_e6 || ext_to_e6(&bal_v, meta.dec_usdt) < usdt_e6 {
        return Err("POOL subaccount insufficient for fee claim".into());
    }

    // 3) 真实 ICRC-1 转账：POOL 子 → 用户子（两笔都成功后再落账）
    if usdc_e6 > 0 {
        let arg_u = Icrc1TransferArg {
            from_subaccount: from_pool.subaccount.clone(),
            to: to_user.clone(),
            amount: int_e6_to_ext(usdc_e6, meta.dec_usdc),
            fee: None, memo: None, created_at_time: None,
        };
        do_icrc1_transfer(meta.ckusdc, arg_u).await
            .map_err(|e| format!("ckUSDC transfer err: {e}"))?;
    }
    if usdt_e6 > 0 {
        let arg_v = Icrc1TransferArg {
            from_subaccount: from_pool.subaccount.clone(),
            to: to_user.clone(),
            amount: int_e6_to_ext(usdt_e6, meta.dec_usdt),
            fee: None, memo: None, created_at_time: None,
        };
        do_icrc1_transfer(meta.ckusdt, arg_v).await
            .map_err(|e| format!("ckUSDT transfer err: {e}"))?;
    }

    // 4) 两笔都成功 → 正式提交内部结算，并同步调整 internal 储备（使用你的真实字段名）
    let who = acct.owner.to_text();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.pool.reserve_usdc = st.pool.reserve_usdc.saturating_sub(usdc_e6);
        st.pool.reserve_usdt = st.pool.reserve_usdt.saturating_sub(usdt_e6);
    });

    let _ = positions::claim_fee(acct).map_err(|e| format!("{:?}", e))?;

    // 用 Withdraw 记录两条（USDC / USDT），前端可标“Claim Fee”
    if usdc_e6 > 0 {
        events::push(Event::Withdraw { who: who.clone(), token: TokenId::USDC, amount: usdc_e6, ts: now() });
    }
    if usdt_e6 > 0 {
        events::push(Event::Withdraw { who: who.clone(), token: TokenId::USDT, amount: usdt_e6, ts: now() });
    }

    Ok((usdc_e6, usdt_e6))
}

/* ---------------- Activity ---------------- */

#[ic_cdk::query]
pub fn get_events(cursor: u128, limit: u128) -> Vec<Event> {
    crate::activity::get_events(cursor, limit)
}

#[ic_cdk::query]
pub fn get_events_latest(limit: u128) -> Vec<Event> {
    crate::activity::get_events_latest(limit)
}

/* ---------------- 权威统计 / 风控 / Cycles ---------------- */

#[query]
pub fn get_tvl_e6() -> u128 {
    STATE.with(|s| {
        let st = s.borrow();
        st.pool.reserve_usdc.saturating_add(st.pool.reserve_usdt)
    })
}

#[query]
pub fn get_stats_snapshot() -> StatsSnapshot {
    STATE.with(|s| {
        let st = s.borrow();
        let n = now();
        let (vol_24, fee_24, swaps_24) = st.stats.sum_last_hours(n, 24);
        let (vol_7d, fee_7d, _swaps_7d) = st.stats.sum_last_hours(n, 168);
        let tvl = st.pool.reserve_usdc.saturating_add(st.pool.reserve_usdt);
        let apy_bp = if tvl == 0 { 0 } else {
            ((fee_24.saturating_mul(365) * 10_000) / tvl).min(u128::from(u32::MAX)) as u32
        };
        StatsSnapshot {
            now_sec: n,
            tvl_e6: tvl,
            vol_24h_e6: vol_24,
            vol_7d_e6: vol_7d,
            fee_24h_e6: fee_24,
            fee_7d_e6: fee_7d,
            swaps_24h: swaps_24,
            apy_24h_bp: apy_bp,
        }
    })
}

#[query]
pub fn get_stats_series(hours: u32) -> Vec<crate::stats::HourBucket> {
    STATE.with(|s| s.borrow().stats.series(now(), hours))
}

#[query]
pub fn get_risk_params() -> RiskParams {
    STATE.with(|s| s.borrow().risk.clone())
}

#[query]
pub fn get_cycles_info() -> CyclesInfo {
    STATE.with(|s| {
        let st = s.borrow();
        let bal = canister_balance128();
        CyclesInfo {
            balance: bal,
            alert_threshold: st.cycles_alert_threshold,
            low: bal < st.cycles_alert_threshold,
        }
    })
}

#[query]
pub fn get_estimated_24h_volume(window_minutes: u32) -> u128 {
    let w = window_minutes.clamp(1, 120) as u64; // 1~120 分钟
    STATE.with(|s| {
        let st = s.borrow();
        let now_sec = now();
        let cutoff = now_sec.saturating_sub(w * 60);
        let mut vol_e6: u128 = 0;
        for ev in st.events.iter().rev() {
            if let Event::Swap { dx_e6, dy_e6, ts, .. } = ev {
                if *ts < cutoff { break; }
                vol_e6 = vol_e6.saturating_add((*dx_e6 + *dy_e6) / 2);
            }
        }
        let scale = (24u128 * 60u128) / (w as u128);
        vol_e6.saturating_mul(scale)
    })
}

/* ---------------- ICRC 辅助 ---------------- */

#[ic_cdk::query]
pub fn get_canister_principal() -> Principal { canister_principal() }

#[ic_cdk::query]
fn get_my_subaccount() -> Vec<u8> {
    let caller = ic_cdk::caller();
    derive_subaccount(caller).to_vec()
}

#[ic_cdk::update]
pub async fn withdraw_from_sub(token_canister: String, to: Account, amount: candid::Nat) -> TextResult {
    use candid::Principal as P;
    let token = match P::from_text(&token_canister) {
        Ok(p) => p,
        Err(e) => return TextResult::Err(format!("invalid token canister id: {e:?}")),
    };
    let caller = ic_cdk::caller();
    match crate::icrc::transfer_from_user_sub(token, caller, to, amount).await {
        Ok(n) => TextResult::Ok(n.to_string()),
        Err(e) => TextResult::Err(e),
    }
}

#[ic_cdk::query]
pub fn get_my_deposit_target() -> DepositTarget {
    let owner = canister_principal();
    let sub   = derive_subaccount(ic_cdk::caller());
    let ai    = crate::icrc::icp_account_identifier(owner, sub);
    DepositTarget { owner, sub: sub.to_vec(), ai_hex: crate::icrc::to_hex32(&ai) }
}

#[ic_cdk::query]
fn get_my_icp_account_id_hex() -> String {
    get_my_deposit_target().ai_hex
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct DepositTarget {
    pub owner: Principal,
    pub sub:   Vec<u8>,
    pub ai_hex: String,
}

#[ic_cdk::query]
pub fn get_deposit_target_for(user: Principal) -> DepositTarget {
    let owner = canister_principal();
    let sub   = derive_subaccount(user);
    let ai    = crate::icrc::icp_account_identifier(owner, sub);
    DepositTarget { owner, sub: sub.to_vec(), ai_hex: crate::icrc::to_hex32(&ai) }
}

/// ICRC-2 授权（保留：提现/代扣前置）
#[ic_cdk::update]
pub async fn ensure_allowance_for_user(token: Principal, min_amount: Nat) -> bool {
    use serde::Deserialize;
    use candid::CandidType;

    let caller = ic_cdk::caller();
    let vault  = ic_cdk::api::id();
    let sub32  = derive_subaccount(caller).to_vec();

    #[derive(CandidType, Deserialize, Clone)]
    struct LAccount { owner: Principal, subaccount: Option<Vec<u8>> }
    #[derive(CandidType, Deserialize)]
    struct AllowanceArgs { account: LAccount, spender: LAccount }
    #[derive(CandidType, Deserialize)]
    struct AllowanceRes { allowance: Nat, expires_at: Option<u64> }
    #[derive(CandidType, Deserialize, Debug)]
    enum TxErr {
        InsufficientAllowance { allowance: Nat },
        InsufficientFunds { balance: Nat },
        BadFee { expected_fee: Nat },
        TooOld,
        CreatedInFuture { ledger_time: u64 },
        Duplicate { duplicate_of: Nat },
        TemporarilyUnavailable,
        GenericError { error_code: Nat, message: String },
        Unauthorized,
    }
    #[derive(CandidType, Deserialize)]
    struct ApproveArgs {
        from_subaccount: Option<Vec<u8>>,
        spender: LAccount,
        amount: Nat,
        expected_allowance: Option<Nat>,
        expires_at: Option<u64>,
        fee: Option<Nat>,
        memo: Option<Vec<u8>>,
        created_at_time: Option<u64>,
    }

    let from    = LAccount { owner: vault,  subaccount: Some(sub32.clone()) };
    let spender = LAccount { owner: caller, subaccount: None };

    // allowance（query）
    let allow_res: Result<(AllowanceRes,), _> =
        ic_cdk::call(token, "icrc2_allowance", (AllowanceArgs { account: from.clone(), spender: spender.clone() },)).await;
    let allowance = match allow_res {
        Ok((res,)) => res.allowance,
        Err(e) => { ic_cdk::print(format!("[ensure_allowance_for_user] allowance call failed: {:?}", e)); return false; }
    };
    if allowance >= min_amount { return false; }

    // 执行 approve（update）
    let args = ApproveArgs {
        from_subaccount: Some(sub32),
        spender,
        amount: min_amount.clone() * Nat::from(100u32),
        expected_allowance: None, expires_at: None, fee: None, memo: None, created_at_time: None,
    };
    let approve_call: Result<(Result<Nat, TxErr>,), _> =
        ic_cdk::call(token, "icrc2_approve", (args,)).await;
    match approve_call {
        Ok((Ok(_txid),)) => true,
        Ok((Err(e),)) => { ic_cdk::print(format!("[ensure_allowance_for_user] approve Err: {:?}", e)); false }
        Err(e) => { ic_cdk::print(format!("[ensure_allowance_for_user] approve call failed: {:?}", e)); false }
    }
}

/* ---------------- 可用余额：对外仅 Nat；fast-path = query 读缓存 ---------------- */

/// 供资产/限额等读取：从 ledger_book 汇总（保持历史接口）
#[ic_cdk::query]
fn get_available_balances(account: Account) -> Available {
    use crate::types::TokenId::{USDC, USDT};
    let mut usdc = Nat::from(0u32);
    let mut usdt = Nat::from(0u32);
    for (tok, val) in crate::ledger_book::get_available_all(account.owner) {
        match tok {
            USDC => usdc = val,
            USDT => usdt = val,
            _ => {}
        }
    }
    Available { usdc, usdt }
}

/// Liquidity 页“我的 live 可用额”（**query**）：读取本地缓存（内部 e6→外部 Nat）
#[ic_cdk::query]
pub fn get_my_available_balances_live() -> Available {
    get_available_balances_live_for(ic_cdk::caller())
}

/// Liquidity 页“指定用户 live 可用额”（**query**）：读取本地缓存（内部 e6→外部 Nat）
#[ic_cdk::query]
pub fn get_available_balances_live_for(who: Principal) -> Available {
    STATE.with(|s| {
        let st = s.borrow();
        let key = skey(&who);
        let u_e6 = *st.user_sub_usdc.get(&key).unwrap_or(&0);
        let t_e6 = *st.user_sub_usdt.get(&key).unwrap_or(&0);
        let du = st.dec_usdc.unwrap_or(6);
        let dt = st.dec_usdt.unwrap_or(6);
        Available {
            usdc: int_e6_to_ext(u_e6, du),
            usdt: int_e6_to_ext(t_e6, dt),
        }
    })
}



#[ic_cdk::update]
pub fn refresh_available_for(user: Principal) -> TextResult {
    ic_cdk::spawn(async move {
        let _ = do_refresh_available_for(user).await;
    });
    TextResult::Ok("scheduled".into())
}

// === 如需“阻塞等待到链上完成”的旧语义，提供一个备用方法 ===
#[ic_cdk::update]
pub async fn refresh_available_for_blocking(user: Principal) -> TextResult {
    match do_refresh_available_for(user).await {
        Ok(()) => TextResult::Ok("ok".into()),
        Err(e) => TextResult::Err(e),
    }
}

// === 实际的刷新实现：并发读取两条账本，写入 e6 缓存 ===
async fn do_refresh_available_for(user: Principal) -> Result<(), String> {
    // 1) 元信息
    let (ckusdc, ckusdt, du, dt) = STATE.with(|s| {
        let st = s.borrow();
        (st.ckusdc, st.ckusdt, st.dec_usdc, st.dec_usdt)
    });
    let (ckusdc, ckusdt, du, dt) = match (ckusdc, ckusdt, du, dt) {
        (Some(a), Some(b), Some(du), Some(dt)) => (a, b, du, dt),
        _ => return Err("token meta not set".into()),
    };

    let acct = crate::types::Account {
        owner: canister_principal(),
        subaccount: Some(derive_subaccount(user).to_vec()),
    };

    // 2) 并发读取（各自仍是 update 流程，但我们同时发出以减少总 wall-time）
    let (u_res, t_res) = futures::future::join(
        icrc1_balance_of(ckusdc, acct.clone()),
        icrc1_balance_of(ckusdt, acct.clone()),
    ).await;

    let (u_nat, t_nat) = match (u_res, t_res) {
        (Ok(a), Ok(b)) => (a, b),
        (ua, tb) => return Err(format!("ledger err: usdc={ua:?}, usdt={tb:?}")),
    };

    // 3) 写入内部 e6 缓存
    let u_e6 = ext_to_int_e6(&u_nat, du);
    let t_e6 = ext_to_int_e6(&t_nat, dt);


    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let key = skey(&user);
        st.user_sub_usdc.insert(key.clone(), u_e6);
        st.user_sub_usdt.insert(key,        t_e6);
        // 如需让“旧的 get_available_balances(Account)”也一致，可顺便写 ledger_book：
        // crate::ledger_book::set_available(user, TokenId::USDC, u_e6);
        // crate::ledger_book::set_available(user, TokenId::USDT, t_e6);
    });

    Ok(())
}


// ------- ICRC-1 transfer 通用参数/错误，用于直接调用 ledger 的 `icrc1_transfer` -------
#[derive(CandidType, Deserialize)]
struct Icrc1TransferArg {
    from_subaccount: Option<Vec<u8>>,
    to: Account,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<serde_bytes::ByteBuf>,
    created_at_time: Option<u64>,
}

#[derive(CandidType, Deserialize)]
enum Icrc1TransferError {
    GenericError { error_code: Nat, message: String },
    TemporarilyUnavailable,
    BadBurn { min_burn_amount: Nat },
    Duplicate { duplicate_of: Nat },
    BadFee { expected_fee: Nat },
    CreatedInFuture { ledger_time: Nat },
    InsufficientFunds { balance: Nat },
    TooOld,
}

// ledger 调用封装：返回区块索引（或错误信息）

// 1) 封装的转账调用
async fn do_icrc1_transfer(
    ledger: Principal,
    arg: Icrc1TransferArg,
) -> std::result::Result<Nat, String> {
    let (res,): (std::result::Result<Nat, Icrc1TransferError>,) =
        ic_call(ledger, "icrc1_transfer", (arg,))
            .await
            .map_err(|(code, msg)| format!("icrc1_transfer call failed: {:?}: {}", code, msg))?;

    match res {
        Ok(block_idx) => Ok(block_idx),
        Err(e) => {
            let msg = match e {
                Icrc1TransferError::GenericError { error_code, message } =>
                    format!("GenericError[{}]: {}", error_code, message),
                Icrc1TransferError::TemporarilyUnavailable =>
                    "TemporarilyUnavailable".to_string(),
                Icrc1TransferError::BadBurn { min_burn_amount } =>
                    format!("BadBurn, min_burn_amount={}", min_burn_amount),
                Icrc1TransferError::Duplicate { duplicate_of } =>
                    format!("Duplicate, duplicate_of={}", duplicate_of),
                Icrc1TransferError::BadFee { expected_fee } =>
                    format!("BadFee, expected_fee={}", expected_fee),
                Icrc1TransferError::CreatedInFuture { ledger_time } =>
                    format!("CreatedInFuture, ledger_time={}", ledger_time),
                Icrc1TransferError::InsufficientFunds { balance } =>
                    format!("InsufficientFunds, balance={}", balance),
                Icrc1TransferError::TooOld =>
                    "TooOld".to_string(),
            };
            Err(msg)
        }
    }
}

#[ic_cdk::update]
pub async fn transfer_from_user_sub_to_pool(
    token_ledger: String,
    user: Principal,
    amount_e6: AmountE6,
) -> TxResultNat {
    if amount_e6 == 0 {
        return TxResultNat::Err("amount_e6 must be > 0".to_string());
    }
    let ledger = match Principal::from_text(&token_ledger) {
        Ok(p) => p,
        Err(_) => return TxResultNat::Err("invalid token_ledger principal text".to_string()),
    };

    let user_sub = derive_subaccount(user).to_vec();
    let arg = Icrc1TransferArg {
        from_subaccount: Some(user_sub),
        to: pool_account(),
        amount: Nat::from(amount_e6 as u128),
        fee: None,
        memo: None,
        created_at_time: None,
    };

    match do_icrc1_transfer(ledger, arg).await {
        Ok(n)  => TxResultNat::Ok(n),
        Err(e) => TxResultNat::Err(e),
    }
}



#[ic_cdk::update]
pub async fn transfer_from_pool_to_user_sub(
    token_ledger: String,
    user: Principal,
    amount_e6: AmountE6,
) -> TxResultNat {
    if amount_e6 == 0 {
        return TxResultNat::Err("amount_e6 must be > 0".to_string());
    }
    let ledger = match Principal::from_text(&token_ledger) {
        Ok(p) => p,
        Err(_) => return TxResultNat::Err("invalid token_ledger principal text".to_string()),
    };

    let to = Account {
        owner: ic_cdk::api::id(),
        subaccount: Some(derive_subaccount(user).to_vec()),
    };
    let arg = Icrc1TransferArg {
        from_subaccount: Some(crate::icrc::POOL_SUBACCOUNT.to_vec()),
        to,
        amount: Nat::from(amount_e6 as u128),
        fee: None,
        memo: None,
        created_at_time: None,
    };

    match do_icrc1_transfer(ledger, arg).await {
        Ok(n)  => TxResultNat::Ok(n),
        Err(e) => TxResultNat::Err(e),
    }
}


#[inline]
fn orient_pair(
    token_in: &TokenId,
    token_out: &TokenId,
    ru_e6: u128,
    rv_e6: u128,
) -> Option<(bool /* in=USDC? */, u128 /*rin*/, u128 /*rout*/)> {
    use crate::types::TokenId::*;
    match (token_in, token_out) {
        (USDC, USDT) => Some((true,  ru_e6, rv_e6)),
        (USDT, USDC) => Some((false, rv_e6, ru_e6)),
        _ => None,
    }
}


// 直接基于 internal 储备报价（不做跨 canister 调用）
#[ic_cdk::query]
pub fn quote_live(token_in: TokenId, token_out: TokenId, dx_e6: AmountE6) -> QuoteOut {
    const E6: u128 = 1_000_000;
    if dx_e6 == 0 {
        return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: E6 };
    }

    // 读内部储备与参数
    let (ru, rv, a_amp_raw, fee_bps) = STATE.with(|s| {
        let st = s.borrow();
        (st.pool.reserve_usdc, st.pool.reserve_usdt, st.pool.a_amp as u128, st.pool.fee_bps as u32)
    });

    // 方向
    let ( _is_usdc_in, rin, rout ) = match orient_pair(&token_in, &token_out, ru, rv) {
        Some(t) => t,
        None => return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: E6 },
    };
    if rin == 0 || rout == 0 {
        return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: E6 };
    }

    // A 归一化 + 报价（与 swap/mod.rs 的公式保持一致）
    let a_norm = if a_amp_raw < 1_000_000 { a_amp_raw * 1_000_000 } else { a_amp_raw };
    let (dy, fee_e6) = stableswap::quote_dx_to_dy(a_norm, rin, rout, dx_e6 as u128, fee_bps);

    let price_e6 = if dx_e6 > 0 { dy.saturating_mul(E6) / (dx_e6 as u128) } else { E6 };
    QuoteOut { dy_e6: dy, fee_e6, price_e6 }
}

/// —— 反向报价：给定目标 dy_e6，计算最小 dx_e6（基于内部储备）——
/// 返回：dx_e6（最小需要投入），fee_e6（基于 dx 的输入侧手续费），price_e6 = dy/dx * 1e6
#[ic_cdk::query]
pub fn quote_exact_out(token_in: TokenId, token_out: TokenId, dy_target_e6: AmountE6) -> QuoteOut {
    if dy_target_e6 == 0 {
        return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 };
    }
    // 读内部池储备
    let (ru, rv, a_raw, fee_bps) = STATE.with(|s| {
        let st = s.borrow();
        (st.pool.reserve_usdc, st.pool.reserve_usdt, st.pool.a_amp as u128, st.pool.fee_bps as u32)
    });
    let (is_usdc_in, rin, rout) = match orient_pair(&token_in, &token_out, ru, rv) {
        Some(t) => t, None => return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 }
    };
    if rin == 0 || rout == 0 { return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 }; }

    let a = if a_raw < 1_000_000 { a_raw * 1_000_000 } else { a_raw };

    // 上界扩张
    let mut lo: u128 = 0;
    let mut hi: u128 = dy_target_e6 as u128; // 乐观起点
    loop {
        let (dy_try, _) = stableswap::quote_dx_to_dy(a, rin, rout, hi, fee_bps);
        if dy_try >= dy_target_e6 as u128 { break; }
        hi = hi.saturating_mul(2).saturating_add(1);
        if hi > 10_000_000_000_000u128 { // 保护
            return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 };
        }
    }

    // 二分求最小 dx
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        let (dy_mid, _) = stableswap::quote_dx_to_dy(a, rin, rout, mid, fee_bps);
        if dy_mid >= dy_target_e6 as u128 { hi = mid; } else { lo = mid; }
    }
    let dx = hi;
    let (dy, fee_e6) = stableswap::quote_dx_to_dy(a, rin, rout, dx, fee_bps);
    let price_e6 = if dx > 0 { dy.saturating_mul(1_000_000) / dx } else { 1_000_000 };
    let _ = is_usdc_in;
    QuoteOut { dy_e6: dx as u128, fee_e6, price_e6 } // 复用结构：这里把 dx 放在 dy_e6 字段返回
}

/// —— 反向报价：给定目标 dy_e6，计算最小 dx_e6（基于实时 live 储备）——
#[ic_cdk::query(composite = true)]
pub async fn quote_live_exact_out(token_in: TokenId, token_out: TokenId, dy_target_e6: AmountE6) -> QuoteOut {
    if dy_target_e6 == 0 {
        return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 };
    }
    let meta = if let Some(m) = get_token_meta() { m } else {
        return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 };
    };
    let pool_acc = get_pool_account("USDC_USDT".to_string());
    let (u_res, v_res) = futures::future::join(
        icrc1_balance_of(meta.ckusdc, pool_acc.clone()),
        icrc1_balance_of(meta.ckusdt, pool_acc.clone()),
    ).await;
    let (u_nat, v_nat) = match (u_res, v_res) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 },
    };
    let ru = ext_to_e6(&u_nat, meta.dec_usdc);
    let rv = ext_to_e6(&v_nat, meta.dec_usdt);

    let (is_usdc_in, rin, rout) = match orient_pair(&token_in, &token_out, ru, rv) {
        Some(t) => t, None => return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 }
    };
    if rin == 0 || rout == 0 { return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 }; }

    let (a_raw, fee_bps) = STATE.with(|s| {
        let st = s.borrow();
        (st.pool.a_amp as u128, st.pool.fee_bps as u32)
    });
    let a = if a_raw < 1_000_000 { a_raw * 1_000_000 } else { a_raw };

    // 上界扩张
    let mut lo: u128 = 0;
    let mut hi: u128 = dy_target_e6 as u128;
    loop {
        let (dy_try, _) = stableswap::quote_dx_to_dy(a, rin, rout, hi, fee_bps);
        if dy_try >= dy_target_e6 as u128 { break; }
        hi = hi.saturating_mul(2).saturating_add(1);
        if hi > 10_000_000_000_000u128 {
            return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: 1_000_000 };
        }
    }
    // 二分
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        let (dy_mid, _) = stableswap::quote_dx_to_dy(a, rin, rout, mid, fee_bps);
        if dy_mid >= dy_target_e6 as u128 { hi = mid; } else { lo = mid; }
    }
    let dx = hi;
    let (dy, fee_e6) = stableswap::quote_dx_to_dy(a, rin, rout, dx, fee_bps);
    let price_e6 = if dx > 0 { dy.saturating_mul(1_000_000) / dx } else { 1_000_000 };
    let _ = is_usdc_in;
    QuoteOut { dy_e6: dx as u128, fee_e6, price_e6 } // 复用字段：返回 dx 放在 dy_e6
}


//新增实时成交（两笔 ICRC-1 转账 + 内部账本同步 + 刷新缓存）：
#[ic_cdk::update]
pub async fn swap_live(args: SwapArgs) -> StdResultSwap {
    use crate::types::TokenId::*;

    if args.dx_e6 == 0 {
        return StdResultSwap::Err("amountIn=0".into());
    }

    // ---------- 读元信息 & 读 live 储备，计算成交 ----------
    let meta = if let Some(m) = get_token_meta() { m } else {
        return StdResultSwap::Err("token meta not set".into());
    };

    let pool_acc = get_pool_account("USDC_USDT".to_string());
    let (u_res, v_res) = futures::future::join(
        icrc1_balance_of(meta.ckusdc, pool_acc.clone()),
        icrc1_balance_of(meta.ckusdt, pool_acc.clone()),
    ).await;

    let (u_nat, v_nat) = match (u_res, v_res) {
        (Ok(a), Ok(b)) => (a, b),
        (ua, vb) => return StdResultSwap::Err(format!("read pool live err: usdc={ua:?}, usdt={vb:?}")),
    };

    let ru_e6 = ext_to_e6(&u_nat, meta.dec_usdc);
    let rv_e6 = ext_to_e6(&v_nat, meta.dec_usdt);

    let (is_usdc_in, rin, rout) = if let Some(t) = orient_pair(&args.token_in, &args.token_out, ru_e6, rv_e6) { t }
    else { return StdResultSwap::Err("unsupported token pair".into()); };

    if rin == 0 || rout == 0 { return StdResultSwap::Err("pool empty".into()); }

    let (a_amp, fee_bps) = STATE.with(|s| {
        let st = s.borrow();
        (st.pool.a_amp as u128, st.pool.fee_bps as u32)
    });
    let a_norm = if a_amp < 1_000_000 { a_amp * 1_000_000 } else { a_amp };

    let dx_e6 = args.dx_e6 as u128;
    let (dy_e6, fee_e6) = stableswap::quote_dx_to_dy(a_norm, rin, rout, dx_e6, fee_bps);

    if dy_e6 == 0 { return StdResultSwap::Err("dy=0".into()); }
    if dy_e6 < (args.min_dy_e6 as u128) { return StdResultSwap::Err("slippage".into()); }

    // ---------- 执行两笔 ICRC-1 转账 ----------
    let user_sub = derive_subaccount(args.account.owner).to_vec();
    let to_user  = Account { owner: canister_principal(), subaccount: Some(user_sub.clone()) };

    // in: 用户子 -> 池子子
    let (in_ledger, out_ledger, dec_in, dec_out) = match (&args.token_in, &args.token_out) {
        (USDC, USDT) => (meta.ckusdc, meta.ckusdt, meta.dec_usdc, meta.dec_usdt),
        (USDT, USDC) => (meta.ckusdt, meta.ckusdc, meta.dec_usdt, meta.dec_usdc),
        _ => return StdResultSwap::Err("unsupported token pair".into()),
    };

    let arg_in = Icrc1TransferArg {
        from_subaccount: Some(user_sub.clone()),
        to: pool_acc.clone(),
        amount: int_e6_to_ext(dx_e6, dec_in),
        fee: None, memo: None, created_at_time: None,
    };
    if let Err(e) = do_icrc1_transfer(in_ledger, arg_in).await {
        return StdResultSwap::Err(format!("debit user_sub failed: {e}"));
    }

    // out: 池子子 -> 用户子
    let arg_out = Icrc1TransferArg {
        from_subaccount: pool_acc.subaccount.clone(),
        to: to_user.clone(),
        amount: int_e6_to_ext(dy_e6, dec_out),
        fee: None, memo: None, created_at_time: None,
    };
    if let Err(e) = do_icrc1_transfer(out_ledger, arg_out).await {
        // 尝试退款（尽力而为）
        let _ = do_icrc1_transfer(
            in_ledger,
            Icrc1TransferArg {
                from_subaccount: pool_acc.subaccount.clone(),
                to: to_user.clone(),
                amount: int_e6_to_ext(dx_e6, dec_in),
                fee: None, memo: None, created_at_time: None,
            },
        ).await;
        return StdResultSwap::Err(format!("credit user_sub failed: {e}"));
    }

    // ---------- 关键：避免嵌套可变借用 ----------
    // 1) 先记手续费（内部会单独借用 STATE）
    positions::accrue_swap_fee(args.token_in.clone(), fee_e6);

    // 2) 再单独进入一次 borrow_mut，更新池内储备
    let dx_net = dx_e6.saturating_sub(fee_e6);
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        if is_usdc_in {
            st.pool.reserve_usdc = st.pool.reserve_usdc.saturating_add(dx_net);
            st.pool.reserve_usdt = st.pool.reserve_usdt.saturating_sub(dy_e6);
        } else {
            st.pool.reserve_usdt = st.pool.reserve_usdt.saturating_add(dx_net);
            st.pool.reserve_usdc = st.pool.reserve_usdc.saturating_sub(dy_e6);
        }
    });

    // 刷新该用户 live 可用额（异步即可；需要强一致可改为 blocking 版本）
    ic_cdk::spawn(async move { let _ = do_refresh_available_for(args.account.owner).await; });
    // 记录 Swap 事件（统一 who = 调用者 principal）
    let who = format!("{}", args.account.owner.to_text());
    events::push(Event::Swap {
        who,
        dx_e6: dx_e6,       // 输入
        dy_e6: dy_e6,       // 输出
        ts: now(),
    });


    StdResultSwap::Ok(SwapOk { dy_e6 })
}
