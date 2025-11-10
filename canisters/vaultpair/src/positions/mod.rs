// canisters/vaultpair/src/positions/mod.rs
use crate::{
    types::{Account, AmountE6, TokenId},
    state::{STATE, skey, State},
    error::{Result, Error},
    events::Event,
};

/// fee 累计指数放大系数（避免精度损失）
const ACC_E18: u128 = 1_000_000_000_000_000_000;

#[inline]
fn owner_key_txt(p: &candid::Principal) -> String { p.to_text() }

/// 结算某用户的“未领取手续费”到 owed_*，并把该用户的 fee 指数更新到当前全局值
fn settle_user_fee(st: &mut State, who: &str, shares: u128) {
    // USDC
    let g_u = st.fee_growth_usdc_e18;
    let i_u = *st.user_fee_idx_usdc.get(who).unwrap_or(&0);
    let du  = g_u.saturating_sub(i_u);
    if du > 0 && shares > 0 {
        let add = shares.saturating_mul(du) / ACC_E18;
        if add > 0 {
            let e = st.user_fee_owed_usdc.entry(who.to_string()).or_default();
            *e = e.saturating_add(add);
        }
    }
    st.user_fee_idx_usdc.insert(who.to_string(), g_u);

    // USDT
    let g_v = st.fee_growth_usdt_e18;
    let i_v = *st.user_fee_idx_usdt.get(who).unwrap_or(&0);
    let dv  = g_v.saturating_sub(i_v);
    if dv > 0 && shares > 0 {
        let add = shares.saturating_mul(dv) / ACC_E18;
        if add > 0 {
            let e = st.user_fee_owed_usdt.entry(who.to_string()).or_default();
            *e = e.saturating_add(add);
        }
    }
    st.user_fee_idx_usdt.insert(who.to_string(), g_v);
}

/// 在 swap 时调用：把“本次输入侧手续费”累加到 fee_vault，并更新增长指数
pub fn accrue_swap_fee(token_in: TokenId, fee_e6: AmountE6) {
    if fee_e6 == 0 { return; }
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let ts = st.pool.total_shares;
        // 没有 LP：费用先攒在 vault，指数不增长（不分配）
        if ts == 0 {
            match token_in {
                TokenId::USDC => st.fee_vault_usdc = st.fee_vault_usdc.saturating_add(fee_e6),
                TokenId::USDT => st.fee_vault_usdt = st.fee_vault_usdt.saturating_add(fee_e6),
                _ => {}
            }
            return;
        }
        match token_in {
            TokenId::USDC => {
                st.fee_vault_usdc = st.fee_vault_usdc.saturating_add(fee_e6);
                let inc = fee_e6.saturating_mul(ACC_E18) / ts;
                st.fee_growth_usdc_e18 = st.fee_growth_usdc_e18.saturating_add(inc);
            }
            TokenId::USDT => {
                st.fee_vault_usdt = st.fee_vault_usdt.saturating_add(fee_e6);
                let inc = fee_e6.saturating_mul(ACC_E18) / ts;
                st.fee_growth_usdt_e18 = st.fee_growth_usdt_e18.saturating_add(inc);
            }
            _ => {}
        }
    });
}

/// 读取“我的 LP 份额”（单位 e6 原值）
pub fn get_user_position(account: Account) -> u128 {
    let who_txt = owner_key_txt(&account.owner);
    STATE.with(|s| {
        let s = s.borrow();
        *s.user_shares.get(&who_txt).unwrap_or(&0)
    })
}

/// 添加流动性：按当前池比例铸造 shares（首次可按加权/几何平均）
pub fn add_liquidity(account: Account, usdc: AmountE6, usdt: AmountE6) -> Result<u128> {
    if usdc == 0 && usdt == 0 { return Err("amount=0".into()); }

    let who_txt = owner_key_txt(&account.owner);
    let s_key   = skey(&account.owner);

    STATE.with(|cell| {
        let mut st = cell.borrow_mut();

        // 可用额校验（main 子账户，内账）
        let avail_u = *st.user_sub_usdc.get(&s_key).unwrap_or(&0);
        let avail_t = *st.user_sub_usdt.get(&s_key).unwrap_or(&0);
        if usdc > avail_u { return Err("insufficient USDC in subaccount".into()); }
        if usdt > avail_t { return Err("insufficient USDT in subaccount".into()); }

        let ru = st.pool.reserve_usdc;
        let rv = st.pool.reserve_usdt;
        let ts = st.pool.total_shares;

        // 首次建池：shares 与 TVL 对齐（u+v）
        let minted = if ts == 0 || ru == 0 || rv == 0 {
            let base = usdc.saturating_add(usdt);
            if base == 0 { return Err("minted=0".into()); }
            base
        } else {
            let m1 = usdc.saturating_mul(ts) / ru;
            let m2 = usdt.saturating_mul(ts) / rv;
            let m  = m1.min(m2);
            if m == 0 { return Err("minted=0".into()); }
            m
        };

        // 扣子账户可用额（按实际扣款）
        st.user_sub_usdc.insert(s_key.clone(), avail_u.saturating_sub(usdc));
        st.user_sub_usdt.insert(s_key.clone(), avail_t.saturating_sub(usdt));

        // 更新池储备与总份额
        st.pool.reserve_usdc = st.pool.reserve_usdc.saturating_add(usdc);
        st.pool.reserve_usdt = st.pool.reserve_usdt.saturating_add(usdt);
        st.pool.total_shares = st.pool.total_shares.saturating_add(minted);

        // 增加用户份额
        let cur = *st.user_shares.get(&who_txt).unwrap_or(&0);
        st.user_shares.insert(who_txt, cur.saturating_add(minted));

        Ok(minted)
    })
}

/// 按份额比例赎回，资产回到 main 子账户（内账）
pub fn remove_liquidity(account: Account, shares: u128) -> Result<(AmountE6, AmountE6)> {
    if shares == 0 { return Err("shares=0".into()); }

    let who_txt = owner_key_txt(&account.owner);
    let s_key   = skey(&account.owner);

    STATE.with(|cell| {
        let mut st = cell.borrow_mut();

        let my = *st.user_shares.get(&who_txt).unwrap_or(&0);
        if shares > my { return Err("insufficient shares".into()); }

        let ts = st.pool.total_shares;
        if ts == 0 { return Err("pool shares=0".into()); }

        let ru = st.pool.reserve_usdc;
        let rv = st.pool.reserve_usdt;

        let amt_usdc = shares.saturating_mul(ru) / ts;
        let amt_usdt = shares.saturating_mul(rv) / ts;

        // 更新池储备与总份额
        st.pool.reserve_usdc = st.pool.reserve_usdc.saturating_sub(amt_usdc);
        st.pool.reserve_usdt = st.pool.reserve_usdt.saturating_sub(amt_usdt);
        st.pool.total_shares = st.pool.total_shares.saturating_sub(shares);

        // 回收份额
        st.user_shares.insert(who_txt.clone(), my.saturating_sub(shares));

        // 资产退回到 main 子账户（内账）
        let cur_u = *st.user_sub_usdc.get(&s_key).unwrap_or(&0);
        let cur_t = *st.user_sub_usdt.get(&s_key).unwrap_or(&0);
        st.user_sub_usdc.insert(s_key.clone(), cur_u.saturating_add(amt_usdc));
        st.user_sub_usdt.insert(s_key,         cur_t.saturating_add(amt_usdt));

        Ok((amt_usdc, amt_usdt))
    })
}

/// 领取手续费：把 owed_* 打入 main 子账户，并记录事件
pub fn claim_fee(account: Account) -> Result<(u128, u128)> {
    let who_txt = owner_key_txt(&account.owner);
    let s_key   = skey(&account.owner);

    STATE.with(|cell| {
        let mut st = cell.borrow_mut();

        // 领取前先按当前 shares 再结算一次
        let my = *st.user_shares.get(&who_txt).unwrap_or(&0);
        settle_user_fee(&mut st, &who_txt, my);

        // 取出 owed
        let owe_u = st.user_fee_owed_usdc.remove(&who_txt).unwrap_or(0);
        let owe_v = st.user_fee_owed_usdt.remove(&who_txt).unwrap_or(0);
        if owe_u == 0 && owe_v == 0 {
            return Ok((0, 0));
        }

        // 从 fee_vault 扣减（防御用 saturating）
        st.fee_vault_usdc = st.fee_vault_usdc.saturating_sub(owe_u);
        st.fee_vault_usdt = st.fee_vault_usdt.saturating_sub(owe_v);

        // 打进 main 子账户（内账）
        let su = *st.user_sub_usdc.get(&s_key).unwrap_or(&0);
        let sv = *st.user_sub_usdt.get(&s_key).unwrap_or(&0);
        st.user_sub_usdc.insert(s_key.clone(), su.saturating_add(owe_u));
        st.user_sub_usdt.insert(s_key.clone(), sv.saturating_add(owe_v));

        // 记事件
        let now = ic_cdk::api::time();
        if owe_u > 0 {
            st.events.push(Event::Withdraw {
                ts: now, who: who_txt.clone(), token: TokenId::USDC, amount: owe_u,
            });
        }
        if owe_v > 0 {
            st.events.push(Event::Withdraw {
                ts: now, who: who_txt.clone(), token: TokenId::USDT, amount: owe_v,
            });
        }

        Ok((owe_u, owe_v))
    })
}

/// 只读：预览“此刻可领取手续费”（不落账）
pub fn preview_claim_fee(account: Account) -> Result<(u128, u128)> {
    let who_txt = owner_key_txt(&account.owner);

    STATE.with(|cell| {
        let st = cell.borrow();

        let shares = *st.user_shares.get(&who_txt).unwrap_or(&0);
        if shares == 0 { return Ok((0, 0)); }

        let idx_u_user = *st.user_fee_idx_usdc.get(&who_txt).unwrap_or(&0);
        let idx_v_user = *st.user_fee_idx_usdt.get(&who_txt).unwrap_or(&0);

        let owed_u_user = *st.user_fee_owed_usdc.get(&who_txt).unwrap_or(&0);
        let owed_v_user = *st.user_fee_owed_usdt.get(&who_txt).unwrap_or(&0);

        // 额外可领 = shares * (全局增长 - 我上次记录) / 1e18
        let add_u = if st.fee_growth_usdc_e18 > idx_u_user {
            shares.saturating_mul(st.fee_growth_usdc_e18 - idx_u_user) / ACC_E18
        } else { 0 };
        let add_v = if st.fee_growth_usdt_e18 > idx_v_user {
            shares.saturating_mul(st.fee_growth_usdt_e18 - idx_v_user) / ACC_E18
        } else { 0 };

        // 当前可领 = 已累积未领 + 额外可领，并与金库余额取 min（防御）
        let can_u = (owed_u_user.saturating_add(add_u)).min(st.fee_vault_usdc);
        let can_v = (owed_v_user.saturating_add(add_v)).min(st.fee_vault_usdt);

        Ok((can_u, can_v))
    })
}

/// 等比缩放所有用户 shares 到 new_total_e6；
/// **分母采用“当前全部用户 shares 之和”**，而不是 `st.pool.total_shares`，避免被演示函数改写后的基准失真。
pub fn admin_rescale_all_shares(new_total_e6: u128) {
    STATE.with(|s| {
        let mut st = s.borrow_mut();

        // 以“实际用户份额之和”做旧分母
        let mut old_total: u128 = 0;
        for v in st.user_shares.values() {
            old_total = old_total.saturating_add(*v);
        }

        if old_total == 0 {
            // 没有 LP：仅更新池总份额（保持用户份额为0）
            st.pool.total_shares = new_total_e6;
            return;
        }

        for (_who, shares) in st.user_shares.iter_mut() {
            *shares = (*shares).saturating_mul(new_total_e6) / old_total;
        }
        st.pool.total_shares = new_total_e6;
    });
}
