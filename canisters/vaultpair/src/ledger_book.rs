// canisters/vaultpair/src/ledger_book.rs
use candid::{CandidType, Nat, Principal};
use serde::{Serialize, Deserialize};
use std::collections::BTreeMap;
use num_traits::ToPrimitive;

use crate::state::STATE;
use crate::types::TokenId;

// =============== 内部类型（e6 存储口径） ===============
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct UserTokenRow {
    pub avail: u128,    // e6
    pub reserved: u128, // e6
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct LedgerBook {
    pub rows: BTreeMap<(Principal, TokenId), UserTokenRow>,
}

// =============== Token 注册表（后端常量） ===============
fn token_principal(tok: &TokenId) -> Principal {
    use candid::Principal as P;
    match tok {
        TokenId::USDC => P::from_text("xevnm-gaaaa-aaaar-qafnq-cai").unwrap(), // ckUSDC
        TokenId::USDT => P::from_text("cngnf-vqaaa-aaaar-qag4q-cai").unwrap(), // ckUSDT
        TokenId::ICP  => P::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap(), // ICP
        TokenId::BOB  => P::from_text("7pail-xaaaa-aaaas-aabmq-cai").unwrap(), // BOB
    }
}

pub const ALL_TOKENS: [TokenId; 4] = [TokenId::USDC, TokenId::USDT, TokenId::ICP, TokenId::BOB];

// =============== 基础读写 ===============
fn set_row(user: Principal, t: TokenId, f: impl FnOnce(&mut UserTokenRow)) {
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let book = &mut st.ledger_book;
        let e = book.rows.entry((user, t)).or_default();
        f(e);
    })
}

#[inline]
pub fn available(user: Principal, t: TokenId) -> u128 {
    STATE.with(|s| {
        let st = s.borrow();
        st.ledger_book.rows.get(&(user, t)).map(|r| r.avail).unwrap_or(0)
    })
}

#[inline]
pub fn reserved(user: Principal, t: TokenId) -> u128 {
    STATE.with(|s| {
        let st = s.borrow();
        st.ledger_book.rows.get(&(user, t)).map(|r| r.reserved).unwrap_or(0)
    })
}

pub fn debit_available(user: Principal, t: TokenId, amt: u128) -> Result<(), String> {
    set_row(user, t, |r| {
        if r.avail < amt { panic!("INSUFFICIENT_AVAILABLE"); }
        r.avail -= amt;
    });
    Ok(())
}
pub fn credit_available(user: Principal, t: TokenId, amt: u128) {
    set_row(user, t, |r| { r.avail = r.avail.saturating_add(amt); });
}
pub fn reserve_for_lp(user: Principal, t: TokenId, amt: u128) -> Result<(), String> {
    set_row(user, t, |r| {
        if r.avail < amt { panic!("INSUFFICIENT_AVAILABLE"); }
        r.avail   -= amt;
        r.reserved = r.reserved.saturating_add(amt);
    });
    Ok(())
}
pub fn release_from_lp(user: Principal, t: TokenId, amt: u128) -> Result<(), String> {
    set_row(user, t, |r| {
        if r.reserved < amt { panic!("INSUFFICIENT_RESERVED"); }
        r.reserved -= amt;
        r.avail     = r.avail.saturating_add(amt);
    });
    Ok(())
}

// =============== 与链上 ICRC-1 对账（把最小单位统一换算为 e6 存） ===============
#[derive(CandidType, Deserialize)]
struct BalReq { owner: Principal, subaccount: Option<Vec<u8>> }

fn nat_to_u128(n: Nat) -> Result<u128, &'static str> {
    n.0.to_u128().ok_or("overflow u128")
}

// 把不同 decimals 的最小单位换成 e6：ckUSDC/ckUSDT=6 原样；ICP/BOB=8 需 /1e2
fn to_e6(tok: TokenId, min_unit: u128) -> u128 {
    match tok {
        TokenId::USDC | TokenId::USDT => min_unit,          // 6
        TokenId::ICP  | TokenId::BOB  => min_unit / 100,    // 8 -> 6
    }
}

pub async fn sync_user_all(user: Principal) -> Result<(), String> {
    let vault = ic_cdk::api::id();
    let sub32 = crate::icrc::derive_subaccount(user).to_vec();

    for t in ALL_TOKENS {
        let can = token_principal(&t);
        let (bal_nat,): (Nat,) = ic_cdk::call(
            can, "icrc1_balance_of", (BalReq { owner: vault, subaccount: Some(sub32.clone()) },)
        ).await.map_err(|e| format!("icrc1_balance_of failed: {:?}", e))?;

        let min_unit = nat_to_u128(bal_nat).map_err(|e| format!("nat->u128: {e}"))?;
        let onchain_e6 = to_e6(t, min_unit);
        set_row(user, t, |r| {
            // 对账策略：以链上余额为准，保留 reserved，不让 avail 变负。
            r.avail = onchain_e6.saturating_sub(r.reserved);
        });
    }
    Ok(())
}

// =============== 导出批量读取（给前端） ===============
pub fn get_available_all(user: Principal) -> Vec<(TokenId, Nat)> {
    ALL_TOKENS.iter()
        .map(|t| {
            let available_balance = available(user, *t);
            (*t, Nat::from(available_balance)) // 将 u128 转换为 Nat 类型
        })
        .collect()
}

pub fn get_reserved_all(user: Principal) -> Vec<(TokenId, Nat)> {
    ALL_TOKENS.iter()
        .map(|t| (*t, Nat::from(reserved(user, *t))))
        .collect()
}

// === 新增：把“可用余额（e6口径）”直接写入 ledger_book ===
pub fn set_available(user: Principal, t: TokenId, amt_e6: u128) {
    set_row(user, t, |r| { r.avail = amt_e6; });
}

// （可选）如果未来需要也把“预留额”写入，可打开下面这个接口
// pub fn set_reserved(user: Principal, t: TokenId, amt_e6: u128) {
//     set_row(user, t, |r| { r.reserved = amt_e6; });
// }
