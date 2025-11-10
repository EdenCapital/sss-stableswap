// canisters/www/src/pages/Liquidity/index.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Principal } from "@dfinity/principal";
import {
  get_pool_info,
  get_user_position,
  add_liquidity,
  remove_liquidity,
  claim_fee,
  fromE6,
  get_unclaimed_fee,
  get_stats_snapshot,
  // 旧：sync_user_ledger_all, get_available_balances
  get_available_balances_live_for,
  refresh_available_for,
  get_token_meta,
  transfer_from_user_sub_to_pool,
  transfer_from_pool_to_user_sub,
  toE6,
  get_pool_reserves_live,
  admin_reconcile_pool_from_live,
} from "../../api/calls";
import { useAuth } from "../../auth/AuthContext";

type Pool = {
  a_amp: number;
  fee_bps: number;
  reserve_usdc: number;     // e6
  reserve_usdt: number;     // e6
  total_shares: number;     // e6
  virtual_price_e6: number; // e6
};

const fmt = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 6 });

// 用真实 principal（非匿名）才返回；否则返回 null
const usePrincipal = () => {
  const { identity } = useAuth() || {};
  const [p, setP] = useState<Principal | null>(null);
  useEffect(() => {
    try {
      if (identity?.getPrincipal) {
        const prin = identity.getPrincipal();
        const anon = Principal.anonymous().toText();
        if (prin && prin.toText() !== anon) {
          setP(prin);
          return;
        }
      }
    } catch (_) {}
    setP(null); // 身份未就绪或匿名时不返回 principal
  }, [identity]);
  return p;
};


export default function LiquidityPage() {
  const { identity } = useAuth() || {};
  const me = usePrincipal();

  const [pool, setPool] = useState<Pool | null>(null);
  const [mySharesNat, setMySharesNat] = useState<number>(0);

  const [poolLive, setPoolLive] = useState<{usdc:number; usdt:number}>({usdc:0, usdt:0});


  // 可用余额：直接读取“live”（外部 Nat → Natural Number，已在 calls.ts 内按 decimals 换算）
  const [avail, setAvail] = useState<{ usdc: number; usdt: number }>({ usdc: 0, usdt: 0 });
  const [syncing, setSyncing] = useState<boolean>(false);

  const [pending, setPending] = useState<{ usdc: number; usdt: number }>({ usdc: 0, usdt: 0 });

  const [vol24h, setVol24h] = useState<number>(0);
  const [apy24hPct, setApy24hPct] = useState<number>(0);

  const [inU, setInU] = useState<string>("100"); // ckUSDC
  const [inV, setInV] = useState<string>("100"); // ckUSDT

  const [removePct, setRemovePct] = useState<string>("10");
  const [busy, setBusy] = useState<null | "add" | "remove" | "claim">(null);

  async function readLiveBalancesSafe(p: Principal) {
    try {
      const a = await get_available_balances_live_for(p);
      setAvail({ usdc: Number(a.usdc || 0), usdt: Number(a.usdt || 0) });
    } catch { /* 忽略一次性失败 */ }
  }

  async function refresh() {
    if (!me) return;

    const p = await get_pool_info();
    setPool(p);

    try {
      const mySharesNatNew = await get_user_position({ owner: me });
      setMySharesNat(Number(mySharesNatNew) || 0);
    } catch { setMySharesNat(0); }

    // 触发后台对账（非阻塞立返），随后轮询直读 live
    try {
      setSyncing(true);
      await refresh_available_for(me, identity); // 返回 "scheduled"
    } catch { /* 即使失败也继续读 live */ } finally {
      setSyncing(false);
    }

    // 立即先读一次（旧值也能展示）
    await readLiveBalancesSafe(me);

    // 轻量轮询：最多 12 次，每 1s；检测到变化立即结束
    try {
      let last = { ...avail };
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const cur = await get_available_balances_live_for(me);
        const changed = cur.usdc !== last.usdc || cur.usdt !== last.usdt;
        if (changed) {
          setAvail({ usdc: cur.usdc, usdt: cur.usdt });
          break;
        }
        last = cur;
      }
    } catch { /* 忽略轮询异常 */ }

    try {
      const uf = await get_unclaimed_fee({ owner: me });
      setPending({ usdc: Number(uf.usdc || 0), usdt: Number(uf.usdt || 0) });
    } catch { setPending({ usdc: 0, usdt: 0 }); }

    try {
      const snap = await get_stats_snapshot();
      setVol24h(Number(snap.vol24h || 0));
      setApy24hPct(Number(snap.apy24h_pct || 0));
    } catch {
      setVol24h(0); setApy24hPct(0);
    }

    try {
      const live = await get_pool_reserves_live();
      setPoolLive(live);
    } catch { setPoolLive({usdc:0, usdt:0}); }
    
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [me, identity]);

  useEffect(() => {
    let alive = true;
    const id = setInterval(async () => {
      try {
        const snap = await get_stats_snapshot();
        if (alive) {
          setVol24h(Number(snap.vol24h || 0));
          setApy24hPct(Number(snap.apy24h_pct || 0));
        }
      } catch {}
    }, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const poolU = useMemo(() => (pool ? fromE6(pool.reserve_usdc) : 0), [pool]);
  const poolV = useMemo(() => (pool ? fromE6(pool.reserve_usdt) : 0), [pool]);
  const poolS = useMemo(() => (pool ? fromE6(pool.total_shares) : 0), [pool]);

  const myShareRatio = useMemo(
    () => (poolS > 0 ? Math.min(mySharesNat / poolS, 1) : 0),  // 封顶 100%
    [mySharesNat, poolS]
  );


  const ratio = useMemo(() => (poolU > 0 ? poolV / poolU : 1), [poolU, poolV]);

  const onChangeU = (e: React.ChangeEvent<HTMLInputElement>) => {
    const u = Math.max(0, Number(e.target.value) || 0);
    setInU(u.toString());
    const v = ratio > 0 ? u * ratio : 0;
    setInV(v ? Number(v.toFixed(6)).toString() : "0");
  };
  const onChangeV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Math.max(0, Number(e.target.value) || 0);
    setInV(v.toString());
    const u = ratio > 0 ? v / ratio : v;
    setInU(u ? Number(u.toFixed(6)).toString() : "0");
  };

  const addPreview = useMemo(() => {
    const u = Number(inU) || 0;
    const v = Number(inV) || 0;
    if (!pool || (u === 0 && v === 0)) return { useU: 0, useV: 0, mint: 0 };
    if (poolS === 0) return { useU: u, useV: v, mint: u + v };
    if (poolU === 0 || poolV === 0) return { useU: 0, useV: 0, mint: 0 };
    const s1 = (u * poolS) / poolU;
    const s2 = (v * poolS) / poolV;
    const mint = Math.min(s1, s2);
    const useU = (mint * poolU) / poolS;
    const useV = (mint * poolV) / poolS;
    return { useU, useV, mint };
  }, [inU, inV, poolU, poolV, poolS, pool]);

  const overU = addPreview.useU > avail.usdc + 1e-12;
  const overV = addPreview.useV > avail.usdt + 1e-12;
  const addDisabled =
    busy !== null ||
    (addPreview.useU <= 0 && addPreview.useV <= 0) ||
    overU || overV;

  const removePreview = useMemo(() => {
    const pct = Math.max(0, Math.min(100, Number(removePct) || 0));
    const burn = (mySharesNat * pct) / 100;
    if (!pool || burn <= 0 || poolS <= 0) return { burn: 0, outU: 0, outV: 0 };
    const outU = (burn * poolU) / poolS;
    const outV = (burn * poolV) / poolS;
    return { burn, outU, outV };
  }, [removePct, mySharesNat, poolU, poolV, poolS, pool]);

  const tvl = poolU + poolV;
  const volOverTVL = tvl > 0 ? vol24h / tvl : 0;
  const tvlLive = useMemo(() => poolLive.usdc + poolLive.usdt, [poolLive]);
  const volOverTVLLive = tvlLive > 0 ? vol24h / tvlLive : 0;

  const claimableSum = (pending.usdc || 0) + (pending.usdt || 0);

  async function onAdd() {
    if (!me) return;

    const uNeed = Number(inU) || 0;
    const vNeed = Number(inV) || 0;
    if (uNeed <= 0 && vNeed <= 0) {
      alert("Please enter an amount for ckUSDC/ckUSDT (Natural Number)");
      return;
    }
    if (overU || overV) {
      alert("❌ Insufficient sub-account balance, please adjust the amount.");
      return;
    }

    try {
      setBusy("add");

      // 1) 读取 TokenMeta（校验已配置）
      const meta = await get_token_meta();
      if (!meta) throw new Error("Token meta not set, please set_token_meta first.");

      // 2) 以预览额为准（可能单边）
      const useU = addPreview.useU > 0 ? addPreview.useU : 0;
      const useV = addPreview.useV > 0 ? addPreview.useV : 0;

      // ✅ 仅调用后端：由后端完成“用户子账户→POOL 子账户”的真实转账 + shares 记账（原子）
      const mintedNat = await add_liquidity({ owner: me }, useU, useV, identity);

      await refresh();
      alert(`✅ Add successful.\nActual deduction: ckUSDC=${fmt(useU)}, ckUSDT=${fmt(useV)};\nMinted Shares=${fmt(mintedNat)}.`);
    } catch (e: any) {
      alert("❌ Add failed: " + (e?.message ?? String(e)));
    } finally {
      setBusy(null);
    }
  }



  async function onRemove() {
    if (!me) return;
    const pct = Math.max(0, Math.min(100, Number(removePct) || 0));
    if (pct <= 0) {
      alert("Please enter a removal percentage (0~100)");
      return;
    }

    try {
      setBusy("remove");

      const burnNat = (mySharesNat * pct) / 100;

      // ✅ 仅调用后端：由后端完成燃烧 shares + “POOL 子账户→用户子账户”的真实转回（原子）
      const { usdc, usdt } = await remove_liquidity({ owner: me }, burnNat, identity);

      await refresh();
      alert(`✅ Remove successful. Returned: ckUSDC=${fmt(usdc)}, ckUSDT=${fmt(usdt)}.`);
    } catch (e: any) {
      alert("❌ Remove failed: " + (e?.message ?? String(e)));
    } finally {
      setBusy(null);
    }
  }



  async function onClaim() {
    if (!me) return;
    try {
      setBusy("claim");
      const { usdc, usdt } = await claim_fee({ owner: me }, identity);
      await refresh();
      alert(`✅ Claim successful. Received: ckUSDC=${fmt(usdc)}, ckUSDT=${fmt(usdt)}.`);
    } catch (e: any) {
      alert("❌ Claim failed: " + (e?.message ?? String(e)));
    } finally { setBusy(null); }
  }

  return (
    <div className="p-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-8">
          <section>
            <h2 className="text-2xl font-semibold mb-4">My Position</h2>
            <div className="space-y-2">
              <div>
                Shares<br />
                <b>{fmt(mySharesNat)}</b>
                <span className="text-sm text-zinc-400"> （Ratio {(myShareRatio * 100).toFixed(6)}%）</span>
              </div>
              <div>
                Underlying<br />
                ckUSDC ≈ <b>{fmt(myShareRatio * poolU)}</b>，ckUSDT ≈ <b>{fmt(myShareRatio * poolV)}</b>
              </div>
              <div className="mt-2">
                Unclaimed Fees<br />
                ckUSDC <b>{fmt(pending.usdc)}</b>，ckUSDT <b>{fmt(pending.usdt)}</b>
                <span className="text-xs text-zinc-500">(Sum ≈ {fmt(claimableSum)})</span>
                <div className="mt-2">
                  <button
                    onClick={onClaim}
                    disabled={busy !== null || claimableSum < 1e-9}
                    className="mt-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded px-4 py-2"
                  >
                    {busy === "claim" ? "Claiming..." : "Claim Fee"}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">
              Add Liquidity
            </h2>
            <div className="text-sm text-zinc-400 mb-2">
              Available Bal： ckUSDC <b>{fmt(avail.usdc)}</b>， ckUSDT <b>{fmt(avail.usdt)}</b>
              {syncing && <span className="ml-2 text-xs text-amber-400">（Syncing…）</span>}
            </div>

            <div className="flex flex-col gap-2 max-w-md">
              <label className="flex items-center gap-2">
                <span className="w-20">ckUSDC</span>
                <input
                  type="number" min={0} step="0.000001" max={avail.usdc}
                  className="bg-zinc-900 rounded px-3 py-2 w-full"
                  value={inU} onChange={onChangeU} placeholder="Natural Number"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="w-20">ckUSDT</span>
                <input
                  type="number" min={0} step="0.000001" max={avail.usdt}
                  className="bg-zinc-900 rounded px-3 py-2 w-full"
                  value={inV} onChange={onChangeV} placeholder="Natural Number"
                />
              </label>

              <div className="text-xs text-zinc-400">
                ckUSDT/ckUSDC ≈ {poolU > 0 ? (poolV / poolU).toFixed(6) : "—"}
              </div>

              <div className="text-sm text-zinc-300">
                Estimated actual deduction：ckUSDC <b>{fmt(addPreview.useU)}</b>，ckUSDT <b>{fmt(addPreview.useV)}</b>；Estimated mint Shares <b>{fmt(addPreview.mint)}</b>
              </div>

              {(addPreview.useU > avail.usdc + 1e-12 || addPreview.useV > avail.usdt + 1e-12) && (
                <div className="text-xs text-red-400">
                  {addPreview.useU > avail.usdc + 1e-12 && <>• ckUSDC Insufficient Balance;</>}
                  {addPreview.useV > avail.usdt + 1e-12 && <>• ckUSDT Insufficient Balance;</>}
                  Please adjust and try again.
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={onAdd}
                  disabled={
                    busy !== null ||
                    (addPreview.useU <= 0 && addPreview.useV <= 0) ||
                    addPreview.useU > avail.usdc + 1e-12 ||
                    addPreview.useV > avail.usdt + 1e-12
                  }
                  className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded px-4 py-2"
                >
                  {busy === "add" ? "Adding..." : "Add"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInU(String(Number(avail.usdc.toFixed(6))));
                    setInV(String(Number(avail.usdt.toFixed(6))));
                  }}
                  className="bg-zinc-800 hover:bg-zinc-700 rounded px-4 py-2"
                >
                  Max
                </button>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-3">Remove Liquidity</h2>
            <div className="flex flex-col gap-2 max-w-md">
              <label className="flex items-center gap-2">
                <span className="w-28">Remove %</span>
                <input
                  type="number" min={0} max={100} step="0.01"
                  className="bg-zinc-900 rounded px-3 py-2 w-full"
                  value={removePct} onChange={(e) => setRemovePct(e.target.value)}
                  placeholder="10"
                />
              </label>
              <div className="text-sm text-zinc-300">
                Estimated burned Shares <b>{fmt(removePreview.burn)}</b>；Estimated return：ckUSDC <b>{fmt(removePreview.outU)}</b>，ckUSDT <b>{fmt(removePreview.outV)}</b>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={onRemove}
                  disabled={busy !== null || mySharesNat <= 0}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2"
                >
                  {busy === "remove" ? "Removing..." : "Remove"}
                </button>
              </div>
            </div>
          </section>
        </div>

        <div>
          <section>
            <h2 className="text-2xl font-semibold mb-4">Pool Overview</h2>
            {!pool ? (
              <div>Loading…</div>
            ) : (
              <div className="space-y-4">
                {/* 基本参数 */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-zinc-400">A (amp)</div>
                    <div className="text-sm">{pool.a_amp}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">Fee (bps)</div>
                    <div className="text-sm">{pool.fee_bps}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">Virtual Price</div>
                    <div className="text-sm">{fromE6(pool.virtual_price_e6)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">Total Shares (internal e6)</div>
                    <div className="text-sm">{fmt(poolS)}</div>
                  </div>
                </div>

                {/* 储备：internal vs live */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-zinc-400">Reserves (internal)</div>
                    <div className="text-sm">
                      ckUSDC {fmt(poolU)} · ckUSDT {fmt(poolV)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">Reserves (live ledger)</div>
                    <div className="text-sm">
                      ckUSDC {fmt(poolLive.usdc)} · ckUSDT {fmt(poolLive.usdt)}
                    </div>
                  </div>
                </div>

                {/* TVL 与 24h 指标：internal vs live */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-zinc-400">TVL (internal)</div>
                    <div className="text-sm">{fmt(tvl)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">TVL (live ledger)</div>
                    <div className="text-sm">{fmt(tvlLive)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">24h Volume (approx)</div>
                    <div className="text-sm">{fmt(vol24h)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">24h Volume / TVL (live)</div>
                    <div className="text-sm">{(volOverTVLLive * 100).toFixed(6)}%</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-xs text-zinc-400">APY(24h)</div>
                    <div className="text-sm">
                      <b>{apy24hPct.toFixed(6)}%</b>
                      <span className="text-xs text-zinc-500">（fee_24h / TVL × 365）</span>
                    </div>
                  </div>
                </div>

                {/* 管理员校准按钮（可选：仅你自己用） */}
                <div className="pt-2 border-t border-zinc-800">
                  <button
                    onClick={async () => {
                      try {
                        const msg = await admin_reconcile_pool_from_live();
                        alert("✅ Reconciled: " + msg);
                        await refresh();
                      } catch (e: any) {
                        alert("❌ Reconcile failed: " + (e?.message ?? String(e)));
                      }
                    }}
                    className="bg-zinc-800 hover:bg-zinc-700 rounded px-3 py-2 text-sm"
                  >
                    Reconcile Internal From Live
                  </button>
                  <span className="ml-2 text-xs text-zinc-500">
                    (Admin only; writes back to internal reserves for alignment display)
                  </span>
                </div>
              </div>
            )}

          </section>
        </div>
      </div>
    </div>
  );
}
