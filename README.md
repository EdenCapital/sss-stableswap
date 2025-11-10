# SSS • StableSwap (ICP)

**Secure · Simple · Swift** — a Curve-v1–based stablecoin AMM on the Internet Computer delivering a **single-update** swap path with a target of **~2s completion** and **~0.5s perceived latency** (M2). The MVP validates the full on-chain flow (deposit → approve → swap → LP) with ~30s end-to-end, then transitions to **internal accounting** for speed while keeping safety and observability.

## Live
- Frontend (mainnet): <REPLACE_WITH_YOUR_FRONTEND_URL>
- Core canister (vaultpair): <REPLACE_WITH_YOUR_CANISTER_ID>
- Forum post: <REPLACE_WITH_FORUM_LINK>
- Demo video (≤2 min): <REPLACE_WITH_VIDEO_LINK>
- One-pager (PDF): <REPLACE_WITH_PDF_LINK>

## Features
- **Fast UX**: single-update swap path (target ~2s completion) + optimistic UI & concurrent prefetch (~0.5s perceived).
- **Native ICRC-1/2**: derived subaccounts, minimal allowances, auditable flows.
- **StableSwap math**: 2-asset Curve-v1 with deterministic safety checks (min-received, slippage caps).
- **Observability**: 24h/7d on-chain stats/events; plan p50/p95 latency, failure rate, cycles/tx dashboard.
- **Extensible**: roadmap to **ckBTC↔BTC** and **Curve-v2-style** pools; reusable StableSwap crate & TypeScript SDK.

## Architecture
- **Canisters**: Rust (IC-CDK), 2-asset StableSwap logic, internal accounting (M2), state versioning & migration rehearsal.
- **Settlement**: MVP uses full on-chain settlement (~30s); M2 shifts to internal accounting; ICRC ledgers used mainly for funding in/out.
- **Frontend**: React/Vite; read-only live quotes; optimistic UI; concurrent prefetch; strict min-received & deadline.
- **Telemetry**: export p50/p95 latency, failures, cycles/tx; 24h/7d volume/TVL/APY.

## Quick Start (local)
**Prereqs**
- dfx ≥ 0.29.x
- Rust (stable) + `wasm32-unknown-unknown` target
- Node.js ≥ 18, npm ≥ 9

**Commands**
```bash
npm --prefix canisters/www install
dfx start --clean --background
dfx deploy


