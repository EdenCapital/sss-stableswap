// canisters/vaultpair/src/math/stableswap.rs
// Curve StableSwap (2-coin) math in pure integer arithmetic.
// - A is stored as amp = A * A_PRECISION (A_PRECISION=1e6)
// - IMPORTANT: ANN = (amp * n^n) / A_PRECISION   <-- 修复点
// - 外部金额单位为 e6（与 AmountE6 一致）；内部用 BigUint 迭代。

use num_bigint::BigUint;
use num_traits::{One, ToPrimitive, Zero};

const N_COINS_U128: u128 = 2;
const A_PRECISION_U128: u128 = 1_000_000; // 1e6

#[inline]
fn bu(x: u128) -> BigUint { BigUint::from(x) }

#[inline]
fn ann(amp_scaled: u128) -> BigUint {
    // 修复：ANN = (A * n^n) / A_PRECISION，其中 amp_scaled = A * A_PRECISION
    let n_pow_n = BigUint::from(N_COINS_U128).pow(N_COINS_U128 as u32); // 4 for n=2
    (bu(amp_scaled) * n_pow_n) / bu(A_PRECISION_U128)
}

/// 计算不变量 D；返回 u128（e6）
pub fn get_d(amp_scaled: u128, x0: u128, x1: u128) -> u128 {
    let s = x0.saturating_add(x1);
    if s == 0 { return 0; }

    let mut d = bu(s);
    let ann_v = ann(amp_scaled);
    let n = bu(N_COINS_U128);

    for _ in 0..256 {
        let denom0 = bu(x0) * &n;
        let denom1 = bu(x1) * &n;
        if denom0.is_zero() || denom1.is_zero() { return 0; }

        let mut d_p = d.clone() * &d / denom0;
        d_p = d_p * &d / denom1;

        let d_prev = d.clone();

        // D = D * (ANN*S + D_P*n) / ((ANN - 1)*D + (n + 1)*D_P)
        let numerator   = ann_v.clone() * bu(s) + d_p.clone() * &n;
        let denominator = (ann_v.clone() - BigUint::one()) * d.clone() + (n.clone() + BigUint::one()) * d_p;

        d = d * numerator / denominator;

        if &d > &d_prev {
            if &d - &d_prev <= BigUint::one() { break; }
        } else if &d_prev - &d <= BigUint::one() { break; }
    }

    d.to_u128().unwrap_or(u128::MAX)
}

/// 在给定不变量 D 下，输入侧新余额 x_i_new（已含净额）时解出输出侧余额 y（e6）
pub fn get_y(amp_scaled: u128, x_i_new: u128, d: u128) -> u128 {
    if x_i_new == 0 { return 0; }

    let ann_v = ann(amp_scaled);
    let d_b   = bu(d);
    let x_b   = bu(x_i_new);
    let n_pow_n = BigUint::from(N_COINS_U128).pow(N_COINS_U128 as u32); // 4

    // 两币池：c = D^(n+1) / (n^n * x * ANN)；b = x + D/ANN
    let c = d_b.clone().pow((N_COINS_U128 as u32) + 1) / (n_pow_n * x_b.clone() * ann_v.clone());
    let b_term = x_b.clone() + d_b.clone() / ann_v.clone();

    let two = BigUint::from(2u32);
    let mut y = d_b.clone();

    for _ in 0..256 {
        let y_prev = y.clone();
        let numerator   = y.clone() * y.clone() + c.clone();
        let denominator = two.clone() * y.clone() + b_term.clone() - d_b.clone();
        y = numerator / denominator;

        if &y > &y_prev {
            if &y - &y_prev <= BigUint::one() { break; }
        } else if &y_prev - &y <= BigUint::one() { break; }
    }

    y.to_u128().unwrap_or(0)
}

/// 报价：给定 (x_in, x_out)、dx（e6）、费率（bps），返回 (dy, fee_in_e6)
pub fn quote_dx_to_dy(
    amp_scaled: u128,
    x_in: u128,
    x_out: u128,
    dx: u128,
    fee_bps: u32,
) -> (u128, u128) {
    if dx == 0 { return (0, 0); }

    let fee_in = (dx as u128) * (fee_bps as u128) / 10_000u128;
    let dx_net = dx.saturating_sub(fee_in);

    let d0 = get_d(amp_scaled, x_in, x_out);
    if d0 == 0 { return (0, fee_in); }

    let x_new = x_in.saturating_add(dx_net);
    let y_new = get_y(amp_scaled, x_new, d0);

    let mut dy = x_out.saturating_sub(y_new);
    if dy > 0 { dy = dy.saturating_sub(1); } // 与 Curve 口径一致，避免过报

    (dy, fee_in)
}

#[cfg(test)]
mod tests {
    use super::*;

    const E6: u128 = 1_000_000;

    #[test]
    fn small_slippage_when_a_large() {
        let amp = 5_000 * A_PRECISION_U128; // A=5000
        let x0 = 10_000 * E6;
        let x1 = 10_000 * E6;
        let dx = 1_000 * E6;

        let (dy, fee) = quote_dx_to_dy(amp, x0, x1, dx, 30);
        assert!(fee > 0);
        assert!(dy >= dx - fee - 2_000);
    }

    #[test]
    fn more_slippage_when_a_small() {
        let x0 = 10_000 * E6;
        let x1 = 10_000 * E6;
        let dx = 1_000 * E6;

        let (dy_small_a, _) = quote_dx_to_dy(10 * A_PRECISION_U128, x0, x1, dx, 30);
        let (dy_large_a, _) = quote_dx_to_dy(5_000 * A_PRECISION_U128, x0, x1, dx, 30);
        assert!(dy_small_a < dy_large_a);
    }

    #[test]
    fn d_is_almost_constant_around_swap() {
        let amp = 100 * A_PRECISION_U128;
        let x0 = 50_000 * E6;
        let x1 = 50_000 * E6;
        let dx = 5_000 * E6;

        let d_before = get_d(amp, x0, x1);
        let (dy, _fee) = quote_dx_to_dy(amp, x0, x1, dx, 0);

        let d_after = get_d(amp, x0 + dx, x1 - dy);
        let diff = if d_after > d_before { d_after - d_before } else { d_before - d_after };
        assert!(diff <= 10);
    }

    #[test]
    fn monotonic_dy_wrt_dx() {
        let amp = 500 * A_PRECISION_U128; // 适中 A
        let x0 = 50_000 * E6;
        let x1 = 50_000 * E6;
        let fee_bps = 30;

        let dxs = [1, 10, 100, 1_000, 5_000, 10_000].map(|v| v as u128 * E6);
        let mut last_dy = 0u128;
        for dx in dxs {
            let (dy, _fee) = quote_dx_to_dy(amp, x0, x1, dx, fee_bps);
            assert!(dy >= last_dy, "non-decreasing: dx={dx}, dy={dy}, last={last_dy}");
            last_dy = dy;
        }
    }

    // A 很小时，StableSwap 价格应介于 XYK 与常和之间：dy_xyk <= dy_stable <= dx-fee
    fn xyk_quote(ru: u128, rv: u128, dx: u128, fee_bps: u32) -> (u128, u128) {
        let fee = dx * (fee_bps as u128) / 10_000u128;
        let dx_net = dx.saturating_sub(fee);
        if ru == 0 || rv == 0 || dx_net == 0 { return (0, fee); }
        let mut dy = rv.saturating_mul(dx_net) / (ru.saturating_add(dx_net));
        if dy > 0 { dy = dy.saturating_sub(1); }
        (dy, fee)
    }

    #[test]
    fn small_a_bounded_between_xyk_and_constant_sum() {
        let amp = 1 * A_PRECISION_U128; // A 很小
        let x0 = 10_000 * E6;
        let x1 = 10_000 * E6;
        let dx = 2_000 * E6;
        let fee_bps = 10;

        let (dy_stable, fee) = quote_dx_to_dy(amp, x0, x1, dx, fee_bps);
        let (dy_xyk,  _f2 ) = xyk_quote(x0, x1, dx, fee_bps);
        let dy_cs = dx - fee; // constant-sum 上界

        assert!(dy_xyk <= dy_stable, "should not be worse than XYK");
        assert!(dy_stable <= dy_cs,  "should not exceed constant-sum");
    }
}
