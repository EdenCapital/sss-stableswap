use crate::types::{AmountE6, TokenId};
use crate::state::STATE;
use candid::CandidType;
use serde::{Deserialize, Serialize};

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum Event {
    Swap      { who: String, dx_e6: AmountE6, dy_e6: AmountE6, ts: u64 },
    AddLiq    { who: String, usdc: AmountE6, usdt: AmountE6, shares: AmountE6, ts: u64 },
    RemoveLiq { who: String, shares: AmountE6, usdc: AmountE6, usdt: AmountE6, ts: u64 },
    Deposit   { who: String, token: TokenId, amount: AmountE6, ts: u64 },
    Withdraw  { who: String, token: TokenId, amount: AmountE6, ts: u64 },
}

pub const MAX_EVENTS: usize = 2000;

/// 统一入口：写入事件并裁剪到 MAX_EVENTS
pub fn push(ev: Event) {
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.events.push(ev);
        if st.events.len() > MAX_EVENTS {
            let overflow = st.events.len() - MAX_EVENTS;
            st.events.drain(0..overflow);
        }
    });
}
