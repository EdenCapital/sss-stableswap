import React from "react";
import { get_pool_info, fromE6, get_events, type PoolInfo, type EventUI } from "../../api/calls";

const fmt = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 6 });

const tsFmt = (ms: number) =>
  new Date(ms).toLocaleString(); // 本地时区 + 本地格式

type Tab = "Tokens" | "Pools" | "Transactions";

export default function Explore() {
  const [info, setInfo] = React.useState<PoolInfo | null>(null);
  const [active, setActive] = React.useState<Tab>("Tokens");

  // Recent Activity（分页）
  const [events, setEvents] = React.useState<EventUI[]>([]);
  const [cursor, setCursor] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const eventsSorted = React.useMemo(
    () => [...events].sort((a, b) => b.ts - a.ts),
    [events]
  );

  React.useEffect(() => {
    get_pool_info().then(setInfo).catch(console.error);
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        setLoadingMore(true);
        const first = await get_events(0, 20);
        setEvents(first);
        setCursor(first.length);
        setHasMore(first.length >= 20);
      } finally {
        setLoadingMore(false);
      }
    })();
  }, []);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    try {
      setLoadingMore(true);
      const batch = await get_events(cursor, 20);
      setEvents((old) => [...old, ...batch]);
      setCursor((c) => c + batch.length);
      setHasMore(batch.length >= 20);
    } finally {
      setLoadingMore(false);
    }
  }

  // ---- 计算自然数视图（池子）
  const vp = info ? fromE6(info.virtual_price_e6) : 0;
  const u  = info ? fromE6(info.reserve_usdc) : 0;
  const v  = info ? fromE6(info.reserve_usdt) : 0;
  const s  = info ? fromE6(info.total_shares) : 0;
  const tvlApprox = u + v;
  const priceUSDTperUSDC = u > 0 ? v / u : 0;

  return (
    <div className="grid cols-2">
      {/* Pool Overview */}
      <div className="card">
        <h3>Pool Overview</h3>
        {!info ? (
          <div className="small">Loading…</div>
        ) : (
          <div className="small">
            <div>A (amp): <b>{info.a_amp}</b></div>
            <div>Fee (bps): <b>{info.fee_bps}</b></div>
            <div>Virtual Price: <b>{fmt(vp)}</b></div>
            <div style={{ marginTop: 8 }}>
              <div>Reserve ckUSDC: <b>{fmt(u)}</b></div>
              <div>Reserve ckUSDT: <b>{fmt(v)}</b></div>
              <div>Total Shares: <b>{fmt(s)}</b></div>
              <div>TVL (approx): <b>{fmt(tvlApprox)}</b></div>
              <div>Price (ckUSDT/ckUSDC): <b>{fmt(priceUSDTperUSDC)}</b></div>
            </div>
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="card">
        <h3>Recent Activity</h3>
        {!events.length ? (
          <div className="small">No data available</div>
        ) : (
          <div className="small" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {eventsSorted.map((e, i) => (
              <div key={i} style={{ opacity: 0.95 }}>
                <span style={{ color: "#9ca3af" }}>{tsFmt(e.ts)}</span>{" "}
                <b>{e.kind}</b>{" "}
                {"who" in e && <><span style={{ color: "#9ca3af" }}>by</span> {(e as any).who} </>}
                {e.kind === "Swap"      && <> — dx={fmt((e as any).dx)} ⇢ dy={fmt((e as any).dy)}</>}
                {e.kind === "AddLiq"    && <> — ckUSDC={fmt((e as any).usdc)}, ckUSDT={fmt((e as any).usdt)}, Shares={fmt((e as any).shares)}</>}
                {e.kind === "RemoveLiq" && <> — ckUSDC={fmt((e as any).usdc)}, ckUSDT={fmt((e as any).usdt)}, Burn={fmt((e as any).shares)}</>}
                {e.kind === "Deposit"   && <> — {(e as any).token}={fmt((e as any).amount)}</>}
                {e.kind === "Withdraw"  && <> — {(e as any).token}={fmt((e as any).amount)}</>}
                {e.kind === "ClaimFee"  && <> — ckUSDC={fmt((e as any).usdc)}, ckUSDT={fmt((e as any).usdt)}</>}
              </div>
            ))}
            {hasMore ? (
              <button
                className="badge"
                onClick={loadMore}
                disabled={loadingMore}
                style={{ width: 120 }}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : (
              <div style={{ color: "#9ca3af" }}>—— no more ——</div>
            )}
          </div>
        )}
      </div>

      {/* Explore Tabs */}
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <h3>Explore</h3>
        <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
          {(["Tokens", "Pools", "Transactions"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setActive(t)}
              className="badge"
              style={{
                cursor: "pointer",
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid #ffffff",
                backgroundColor: active === t ? "#ffffff" : "transparent",
                color: active === t ? "#111111" : "#ffffff",
                fontWeight: 600,
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tokens */}
        {active === "Tokens" && (
          <table className="table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Reserve (natural)</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>ckUSDC</td>
                <td>{fmt(u)}</td>
                <td>Stable</td>
              </tr>
              <tr>
                <td>ckUSDT</td>
                <td>{fmt(v)}</td>
                <td>Stable</td>
              </tr>
            </tbody>
          </table>
        )}

        {/* Pools */}
        {active === "Pools" && (
          <table className="table">
            <thead>
              <tr>
                <th>A (amp)</th>
                <th>Fee (bps)</th>
                <th>Virtual Price</th>
                <th>Total Shares</th>
                <th>TVL (approx)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{info ? info.a_amp : "—"}</td>
                <td>{info ? info.fee_bps : "—"}</td>
                <td>{fmt(vp)}</td>
                <td>{fmt(s)}</td>
                <td>{fmt(tvlApprox)}</td>
              </tr>
            </tbody>
          </table>
        )}

        {/* Transactions */}
        {active === "Transactions" && (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Who</th>
                <th>Type</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {!events.length && (
                <tr>
                  <td colSpan={4}>No data available</td>
                </tr>
              )}
              {eventsSorted.map((e, i) => (
                <tr key={i}>
                  <td>{tsFmt(e.ts)}</td>
                  <td style={{ maxWidth: 240, textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" }}>
                    {"who" in e ? (e as any).who : "—"}
                  </td>
                  <td>{e.kind}</td>
                  <td>
                    {e.kind === "Swap"      && `dx=${fmt((e as any).dx)} → dy=${fmt((e as any).dy)}`}
                    {e.kind === "AddLiq"    && `ckUSDC=${fmt((e as any).usdc)}, ckUSDT=${fmt((e as any).usdt)}, Shares=${fmt((e as any).shares)}`}
                    {e.kind === "RemoveLiq" && `ckUSDC=${fmt((e as any).usdc)}, ckUSDT=${fmt((e as any).usdt)}, Burn=${fmt((e as any).shares)}`}
                    {e.kind === "Deposit"   && `${(e as any).token}=${fmt((e as any).amount)}`}
                    {e.kind === "Withdraw"  && `${(e as any).token}=${fmt((e as any).amount)}`}
                    {e.kind === "ClaimFee"  && `ckUSDC=${fmt((e as any).usdc)}, ckUSDT=${fmt((e as any).usdt)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
