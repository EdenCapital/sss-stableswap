// canisters/vaultpair/src/swap/mod.rs
use crate::{
    types::{TokenId, AmountE6, QuoteOut, SwapArgs},
    state::{STATE, skey},
    error::{Result, Error},
    math::stableswap,
    positions, // 手续费入金库/指数
};
use num_bigint::BigUint;

const E6: u128 = 1_000_000;
const A_PRECISION: u128 = 1_000_000;

#[inline]
fn orient(token_in: &TokenId, token_out: &TokenId, usdc: u128, usdt: u128)
    -> Option<(bool /*in=USDC?*/, u128 /*rin*/, u128 /*rout*/)>
{
    match (token_in, token_out) {
        (TokenId::USDC, TokenId::USDT) => Some((true,  usdc, usdt)),
        (TokenId::USDT, TokenId::USDC) => Some((false, usdt, usdc)),
        _ => None,
    }
}

#[inline]
fn normalize_amp(a_raw: u128) -> u128 {
    if a_raw < A_PRECISION { a_raw.saturating_mul(A_PRECISION) } else { a_raw }
}

pub fn quote(token_in: TokenId, token_out: TokenId, dx_e6: AmountE6) -> QuoteOut {
    let (usdc, usdt, a_amp_raw, fee_bps) = STATE.with(|s| {
        let s = s.borrow();
        (s.pool.reserve_usdc, s.pool.reserve_usdt, s.pool.a_amp as u128, s.pool.fee_bps)
    });

    if dx_e6 == 0 {
        return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: E6 };
    }

    let (is_usdc_in, rin, rout) = match orient(&token_in, &token_out, usdc, usdt) {
        Some(x) => x,
        None => return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: E6 },
    };
    if rin == 0 || rout == 0 {
        return QuoteOut { dy_e6: 0, fee_e6: 0, price_e6: E6 };
    }

    let amp = normalize_amp(a_amp_raw);
    let (dy, fee_e6) = stableswap::quote_dx_to_dy(amp, rin, rout, dx_e6 as u128, fee_bps as u32);
    let price_e6 = if dx_e6 > 0 { dy.saturating_mul(E6) / (dx_e6 as u128) } else { E6 };
    let _ = is_usdc_in;
    QuoteOut { dy_e6: dy, fee_e6, price_e6 }
}

pub fn swap(args: SwapArgs) -> Result<BigUint> {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();

        // 入参与方向
        let key = skey(&args.account.owner);
        let dx  = args.dx_e6 as u128;
        if dx == 0 { return Err("amountIn=0".into()); }

        let (is_usdc_in, rin, rout) = match orient(&args.token_in, &args.token_out,
                                                   st.pool.reserve_usdc, st.pool.reserve_usdt) {
            Some(x) => x,
            None => return Err("unsupported token pair".into()),
        };

        // 可用额校验
        if is_usdc_in {
            let avail = *st.user_sub_usdc.get(&key).unwrap_or(&0);
            if dx > avail { return Err("insufficient USDC in subaccount".into()); }
        } else {
            let avail = *st.user_sub_usdt.get(&key).unwrap_or(&0);
            if dx > avail { return Err("insufficient USDT in subaccount".into()); }
        }
        if rin == 0 || rout == 0 { return Err("pool empty".into()); }

        // 计价：得到 dy 与“输入侧手续费” fee_e6
        let amp = normalize_amp(st.pool.a_amp as u128);
        let (dy, fee_e6) = stableswap::quote_dx_to_dy(amp, rin, rout, dx, st.pool.fee_bps as u32);
        if dy == 0 { return Err("dy=0".into()); }

        // 最小接收量保护
        let min_dy = args.min_dy_e6 as u128;
        if dy < min_dy { return Err("slippage".into()); }

        // 手续费记入 fee_vault（不进储备）
        positions::accrue_swap_fee(args.token_in.clone(), fee_e6);

        // 净投入（进入池储备）
        let dx_net = dx.saturating_sub(fee_e6);

        if is_usdc_in {
            // 扣 USDC，可用额；加 USDT
            let u0 = *st.user_sub_usdc.get(&key).unwrap_or(&0);
            let v0 = *st.user_sub_usdt.get(&key).unwrap_or(&0);
            st.user_sub_usdc.insert(key.clone(), u0.saturating_sub(dx));
            st.user_sub_usdt.insert(key.clone(), v0.saturating_add(dy));

            // 储备：只加净投入
            st.pool.reserve_usdc = st.pool.reserve_usdc.saturating_add(dx_net);
            st.pool.reserve_usdt = st.pool.reserve_usdt.saturating_sub(dy);
        } else {
            let u0 = *st.user_sub_usdt.get(&key).unwrap_or(&0);
            let v0 = *st.user_sub_usdc.get(&key).unwrap_or(&0);
            st.user_sub_usdt.insert(key.clone(), u0.saturating_sub(dx));
            st.user_sub_usdc.insert(key.clone(), v0.saturating_add(dy));

            st.pool.reserve_usdt = st.pool.reserve_usdt.saturating_add(dx_net);
            st.pool.reserve_usdc = st.pool.reserve_usdc.saturating_sub(dy);
        }

        Ok(BigUint::from(dy))
    })
}
