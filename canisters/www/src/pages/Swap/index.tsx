import React, { useEffect, useMemo, useState } from "react";
import { Principal } from "@dfinity/principal";
import {
  quote,
  swap,
  get_pool_info as getPoolInfo,
  fromE6,
  refresh_available_for,
  get_available_balances_live_for,
  refresh_and_poll_available,
  deposit_ckusdc_to_my_sub,
  deposit_ckusdt_to_my_sub,
  get_pool_reserves_live, 
  type TokenId,
} from "../../api/calls";
import { useAuth } from "../../auth/AuthContext";

/** 后端仍用 {USDC|USDT}，UI 显示为 ckUSDC/ckUSDT */
const USDC: TokenId = { USDC: null };
const USDT: TokenId = { USDT: null };

type Ticker = "ckUSDC" | "ckUSDT";
const toTokenId = (t: Ticker): TokenId => (t === "ckUSDC" ? USDC : USDT);

type BalKey = "usdc" | "usdt";
const balKeyOf = (t: Ticker): BalKey => (t === "ckUSDC" ? "usdc" : "usdt");

const fmt = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 6 });

/** 非匿名主体则返回 principal，否则 null */
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
    } catch {}
    setP(null);
  }, [identity]);
  return p;
};

type Mode = "EXACT_IN" | "EXACT_OUT";

export default function SwapPage() {
  const { identity } = useAuth() || {};
  const me = usePrincipal();

  const [sellTicker, setSellTicker] = useState<Ticker>("ckUSDC");
  const [buyTicker, setBuyTicker] = useState<Ticker>("ckUSDT");
  const [mode, setMode] = useState<Mode>("EXACT_IN");

  const [sellAmt, setSellAmt] = useState<string>("");
  const [buyAmt, setBuyAmt] = useState<string>("");

  const [price, setPrice] = useState<number>(1);
  const [fee, setFee] = useState<number>(0);
  const [feeBps, setFeeBps] = useState<number>(10);

  const [slipPct, setSlipPct] = useState<number>(0.5);
  const [busy, setBusy] = useState(false);

  // ===== “只采纳最新一次报价结果” 的竞态防护 + 防抖 =====
  const quoteSeqRef = React.useRef(0);               // 递增序号
  const sellTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const buyTimerRef  = React.useRef<ReturnType<typeof setTimeout>  | null>(null);

  // 池子实时储备
  const [poolLive, setPoolLive] = useState<{usdc:number; usdt:number}>({usdc:0, usdt:0});


  // live 子账户余额（自然数）
  const [balances, setBalances] = useState<{ usdc: number; usdt: number }>({
    usdc: 0,
    usdt: 0,
  });

  const sellTokenId = useMemo(() => toTokenId(sellTicker), [sellTicker]);
  const buyTokenId  = useMemo(() => toTokenId(buyTicker), [buyTicker]);

  const canPair = (a: Ticker, b: Ticker) =>
    (a === "ckUSDC" && b === "ckUSDT") || (a === "ckUSDT" && b === "ckUSDC");

  function reverse() {
    setSellTicker(buyTicker);
    setBuyTicker(sellTicker);
    setSellAmt(buyAmt || "");
    setBuyAmt(sellAmt || "");
    // 翻转时保持“卖出框为控制端”
    setMode((m) => (m === "EXACT_IN" ? "EXACT_IN" : "EXACT_OUT"));
  }

  /* 费率 */
  useEffect(() => {
    (async () => {
      const info = await getPoolInfo();
      setFeeBps(Number(info.fee_bps ?? 10));
    })();
  }, []);

  /* 刷新链上余额（与 Liquidity 一致） */
  async function refreshBalances() {
    if (!me) {
      setBalances({ usdc: 0, usdt: 0 });
      return;
    }
    try { await refresh_available_for(me, identity); } catch {}
    try {
      const a = await get_available_balances_live_for(me);
      setBalances({ usdc: Number(a.usdc || 0), usdt: Number(a.usdt || 0) });
    } catch {
      setBalances({ usdc: 0, usdt: 0 });
    }
  }

  /* 单次报价：给定 dx（自然数）→ {dy, fee, p} */
  async function quoteDy(dxNat: number): Promise<{ dy: number; feeNat: number; p: number }> {
    const r = await quote(sellTokenId, buyTokenId, dxNat);
    return {
      dy: Number(fromE6(r.dy_e6)),
      feeNat: Number(fromE6(r.fee_e6)),
      p: Number(fromE6(r.price_e6)),
    };
  }

  /* 精确卖出：根据卖出额求买入额 */
  async function reQuoteExactIn(nextSell?: string) {
    const v = Math.max(0, Number(nextSell ?? sellAmt) || 0);
    const mySeq = ++quoteSeqRef.current;

    if (!v || !canPair(sellTicker, buyTicker)) {
      // 仅当输入真为空时清空；避免被异步覆盖造成“闪烁后清空”
      if ((nextSell ?? sellAmt).trim() === "") {
        if (mySeq === quoteSeqRef.current) {
          setBuyAmt("");
          setPrice(1);
          setFee(0);
        }
      }
      return;
    }

    const { dy, feeNat, p } = await quoteDy(v);
    if (mySeq !== quoteSeqRef.current) return; // 过期结果丢弃

    setBuyAmt(dy > 0 ? String(dy) : "0");
    setPrice(p || 1);
    setFee(feeNat || 0);
  }


  /* 精确买入：根据目标 buy 求所需 sell —— 指数扩张 + 二分 */
  async function solveDxForTargetDy(targetDyNat: number) {
    const mySeq = ++quoteSeqRef.current;
    if (targetDyNat <= 0) { setSellAmt(""); return; }

    // ① 用价格近似得到首猜
    let guess = Math.max(1e-12, targetDyNat);
    try {
      const { p, feeNat } = await quoteDy(1);
      // feeNat 是 1 的手续费（≈ fee_bps/1e4），用它做个放大保护
      const feeFactor = 1 + Math.max(0, Number(feeNat) || 0);
      if (p > 0) guess = (targetDyNat / p) * feeFactor * 1.002;
    } catch {}

    // 受余额上限约束
    const maxDx = balances[balKeyOf(sellTicker)] || Number.POSITIVE_INFINITY;
    guess = Math.min(guess, maxDx);
    if (!isFinite(guess) || guess <= 0) guess = Math.min(1, maxDx);

    // ②～③ 迭代 2 次修正：dx_{k+1} = dx_k * target/dy(dx_k)
    for (let i = 0; i < 2; i++) {
      const { dy } = await quoteDy(guess);
      if (mySeq !== quoteSeqRef.current) return; // 过期丢弃
      if (dy <= 0) break;
      const ratio = targetDyNat / dy;
      // 收敛保护 & 余额约束
      guess = Math.min(maxDx, guess * Math.max(0.5, Math.min(2.0, ratio)));
      if (Math.abs(dy - targetDyNat) <= Math.max(1e-9, targetDyNat * 1e-6)) break;
    }

    // 最终回写
    const { dy, feeNat, p } = await quoteDy(guess);
    if (mySeq !== quoteSeqRef.current) return; // 过期丢弃

    setSellAmt(String(guess));
    setPrice(p || 1);
    setFee(feeNat || 0);
    setBuyAmt(String(dy));
  }


  /* 根据模式刷新另一侧 */
  async function refreshLinked() {
    if (mode === "EXACT_IN") await reQuoteExactIn();
    else {
      const target = Math.max(0, Number(buyAmt) || 0);
      await solveDxForTargetDy(target);
    }
  }

  // 登录主体/身份变化：只刷新余额
  useEffect(() => {
    (async () => { await refreshBalances(); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, identity]);

  // 交易对方向变化：按当前模式联动一次报价
  useEffect(() => {
    (async () => { await refreshLinked(); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellTicker, buyTicker]);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const live = await get_pool_reserves_live();
        if (alive) setPoolLive(live);
      } catch {}
    };
    read();
    const id = setInterval(read, 10_000); // 每 10s 刷一次
    return () => { alive = false; clearInterval(id); };
  }, []);
  


  /* 输入：卖出端 */
  const onChangeSell = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMode("EXACT_IN");
    const val = e.target.value;
    setSellAmt(val);
    if (sellTimerRef.current) clearTimeout(sellTimerRef.current);
    sellTimerRef.current = setTimeout(() => { reQuoteExactIn(val); }, 150);
  };

  const onChangeBuy = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMode("EXACT_OUT");
    const val = e.target.value;
    setBuyAmt(val);
    const v = Math.max(0, Number(val) || 0);
    if (buyTimerRef.current) clearTimeout(buyTimerRef.current);
    buyTimerRef.current = setTimeout(() => { solveDxForTargetDy(v); }, 150);
  };


  /* 最小接收量（滑点保护） */
  const minOut = useMemo(() => {
    const dy = Number(buyAmt) || 0;
    return dy * (1 - slipPct / 100);
  }, [buyAmt, slipPct]);

  async function onSwap() {
    if (!me) return alert("Please log in first");
    if (!canPair(sellTicker, buyTicker)) return alert("Only ckUSDC ↔ ckUSDT is supported yet.");

    const dx = Number(sellAmt) || 0;
    const dy = Number(buyAmt) || 0;
    if (dx <= 0 || dy <= 0) return;

    // 余额检查
    const sellKey: BalKey = balKeyOf(sellTicker);
    const avail = balances[sellKey] || 0;
    if (dx > avail + 1e-12) {
      return alert(`❌ Insufficient ${sellTicker} balance. Available: ${fmt(avail)}`);
    }

    setBusy(true);
    try {
      await swap({
        account: { owner: me },
        token_in: sellTokenId,
        token_out: buyTokenId,
        dx_e6: dx,
        min_dy_e6: minOut,
      });

      await new Promise((r) => setTimeout(r, 500));
      await refreshBalances();
      await refreshLinked();
      alert("✅ Swap completed");
    } catch (e: any) {
      alert("❌ Swap failed: " + (e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  }

  // 充值（主 → 子）
  async function onDeposit(t: Ticker) {
    if (!me) return alert("Please log in first");
    const inp = prompt(`Enter deposit amount for ${t}:`, "10");
    const v = Number(inp);
    if (!inp || !Number.isFinite(v) || v <= 0) return;

    setBusy(true);
    try {
      if (t === "ckUSDC") {
        await deposit_ckusdc_to_my_sub(v, identity);
      } else {
        await deposit_ckusdt_to_my_sub(v, identity);
      }
      // 充值完成后，触发刷新并轮询到位余额
      await refresh_and_poll_available(me, { tries: 12, intervalMs: 1000 }, identity);
      await refreshBalances();
      alert("✅ Deposit successful");
    } catch (e: any) {
      alert("❌ Deposit failed: " + (e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  }

  const sellKey: BalKey = balKeyOf(sellTicker);
  const buyKey:  BalKey = balKeyOf(buyTicker);

  // Swap 按钮点亮条件
  const canSwap =
    !busy &&
    Number(buyAmt) > 0 &&
    Number(sellAmt) > 0 &&
    Number(sellAmt) <= (balances[sellKey] || 0);

  return (
    <div className="p-4 space-y-3">
      <div className="text-sm text-zinc-400">Fee: {feeBps} bps</div>

      <div>
        Available balance (sell): {fmt(balances[sellKey])} {sellTicker}
        <button
          className="ml-2 bg-zinc-800 hover:bg-zinc-700 rounded px-2 py-1 text-sm"
          onClick={() => onDeposit(sellTicker)}
          disabled={busy}
        >
          Deposit
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          className="bg-zinc-900 rounded px-3 py-2 w-60"
          value={sellAmt}
          onChange={onChangeSell}
          placeholder={`Sell amount (${sellTicker})`}
        />
        <select
          className="bg-zinc-900 rounded px-2 py-2"
          value={sellTicker}
          onChange={(e) => setSellTicker(e.target.value as Ticker)}
        >
          <option value="ckUSDC">ckUSDC</option>
          <option value="ckUSDT">ckUSDT</option>
        </select>
        <button
          type="button"
          className="bg-zinc-800 hover:bg-zinc-700 rounded px-3 py-2 text-sm"
          onClick={() => {
            const v = balances[sellKey] || 0;
            setMode("EXACT_IN");
            setSellAmt(String(v));
            reQuoteExactIn(String(v));
          }}
        >
          Max
        </button>
      </div>

      <button className="bg-zinc-800 px-2 py-1 rounded" onClick={reverse}>
        ⇅
      </button>

      <div>
        Available balance (buy): {fmt(balances[buyKey])} {buyTicker}
        <button
          className="ml-2 bg-zinc-800 hover:bg-zinc-700 rounded px-2 py-1 text-sm"
          onClick={() => onDeposit(buyTicker)}
          disabled={busy}
        >
          Deposit
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          className="bg-zinc-900 rounded px-3 py-2 w-60"
          value={buyAmt}
          onChange={onChangeBuy}
          placeholder={`Buy amount (${buyTicker})`}
        />
        <select
          className="bg-zinc-900 rounded px-2 py-2"
          value={buyTicker}
          onChange={(e) => setBuyTicker(e.target.value as Ticker)}
        >
          <option value="ckUSDC">ckUSDC</option>
          <option value="ckUSDT">ckUSDT</option>
        </select>
      </div>

      <div className="text-sm text-zinc-400">
        Price ≈ {price ? price.toFixed(6) : "—"} {buyTicker}/{sellTicker}
      </div>
      <div className="text-sm text-zinc-400">
        Fee ≈ {fmt(fee)} {sellTicker}（{feeBps} bps）
      </div>
      <div className="text-sm text-zinc-400">
        Slippage:
        <input
          type="number"
          min={0.05}
          step={0.05}
          className="bg-zinc-900 rounded px-2 py-1 w-24 ml-2"
          value={slipPct}
          onChange={(e) => setSlipPct(Math.max(0.05, Number(e.target.value) || 0))}
        /> %
      </div>
      <div className="text-sm text-zinc-400">
        Min received ≈ {fmt(minOut)} {buyTicker}
      </div>
      <div className="text-sm text-zinc-400">
        Pool (live) reserves: ckUSDC {fmt(poolLive.usdc)} · ckUSDT {fmt(poolLive.usdt)} ·
        TVL {fmt(poolLive.usdc + poolLive.usdt)}
      </div>
      

      <div>
        <button
          onClick={onSwap}
          disabled={!canSwap}
          className="bg-pink-600 hover:bg-pink-500 disabled:opacity-50 rounded px-4 py-2"
        >
          {busy ? "Swapping..." : "Swap"}
        </button>
      </div>
    </div>
  );
}
