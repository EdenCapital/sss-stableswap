use candid::{CandidType, Principal, Nat};
use serde::{Deserialize, Serialize};

pub type AmountE6 = u128;

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct Available {
    pub usdc: Nat,
    pub usdt: Nat,
}

#[derive(
    CandidType, Serialize, Deserialize,
    Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash
)]
pub enum TokenId { USDC, USDT, ICP, BOB }

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Account { pub owner: Principal, pub subaccount: Option<Vec<u8>> }

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct PoolInfo {
    pub a_amp: u32,
    pub fee_bps: u16,
    pub reserve_usdc: AmountE6,
    pub reserve_usdt: AmountE6,
    pub total_shares: AmountE6,
    pub virtual_price_e6: u128,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct QuoteOut { pub dy_e6: AmountE6, pub fee_e6: AmountE6, pub price_e6: u128 }

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct SwapArgs {
    pub account: Account,
    pub token_in: TokenId,
    pub token_out: TokenId,
    pub dx_e6: AmountE6,
    pub min_dy_e6: AmountE6,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct Position { pub shares: AmountE6 }

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct SubBalance {
    pub id: String,
    pub usdc: AmountE6,
    pub usdt: AmountE6,
    pub bob: AmountE6,
    pub icp: AmountE6,
}

/* ===== 追加：统计 / 风控 / Cycles 类型 ===== */

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct RiskParams {
    pub max_price_impact_bps: u32, // 价格冲击上限（相对 1:1）
    pub d_tolerance_e6: u64,       // D 不变量允许的绝对漂移（e6）
}
// 为了让 State 可以 #[derive(Default)]，提供 RiskParams 的 Default
impl Default for RiskParams {
    fn default() -> Self {
        Self { max_price_impact_bps: 3000, d_tolerance_e6: 50 }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct StatsSnapshot {
    pub now_sec: u64,
    pub tvl_e6: u128,
    pub vol_24h_e6: u128,
    pub vol_7d_e6: u128,
    pub fee_24h_e6: u128,
    pub fee_7d_e6: u128,
    pub swaps_24h: u32,
    pub apy_24h_bp: u32, // 24h 年化 APY（bps）
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct CyclesInfo {
    pub balance: u128,
    pub alert_threshold: u128,
    pub low: bool,
}
