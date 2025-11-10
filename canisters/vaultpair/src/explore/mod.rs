use crate::{types::PoolInfo, state::STATE};

pub fn get_pool_info()->PoolInfo{
    STATE.with(|s| {
        let p = &s.borrow().pool;
        PoolInfo{
            a_amp: p.a_amp,
            fee_bps: p.fee_bps,
            reserve_usdc: p.reserve_usdc,
            reserve_usdt: p.reserve_usdt,
            total_shares: p.total_shares,
            virtual_price_e6: p.virtual_price_e6,
        }
    })
}

// 仅用于本地演示：直接写池子储备
pub fn seed_pool_demo(usdc:u128, usdt:u128) -> PoolInfo {
    STATE.with(|s|{
        let mut st = s.borrow_mut();
        st.pool.reserve_usdc = usdc;
        st.pool.reserve_usdt = usdt;
        st.pool.total_shares = usdc + usdt; // 简化：1:1 估值
        st.pool.virtual_price_e6 = 1_000_000;
        PoolInfo{
            a_amp: st.pool.a_amp,
            fee_bps: st.pool.fee_bps,
            reserve_usdc: st.pool.reserve_usdc,
            reserve_usdt: st.pool.reserve_usdt,
            total_shares: st.pool.total_shares,
            virtual_price_e6: st.pool.virtual_price_e6,
        }
    })
}
