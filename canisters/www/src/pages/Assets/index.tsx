// canisters/www/src/pages/Assets/index.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { Principal } from "@dfinity/principal";
import { getVaultpairActor, createAgent } from "../../api/actor"; // ← 新增 createAgent
import {
  readTokenInfo, icrcBalanceOf, fromUnit, toUnit, type TokenInfo, icrc1Transfer,
  readTokenInfoWithAgent, icrcBalanceOfWithAgent, icrc2Supported, icrc2AllowanceWithAgent, 
  icrc2TransferFromWithAgent
} from "../../api/token";
import { withdraw_from_sub, ensure_allowance_for_user, get_deposit_target_for } from "../../api/calls";

const TOKENS = [
  { key: "ckUSDC", id: "xevnm-gaaaa-aaaar-qafnq-cai" },
  { key: "ckUSDT", id: "cngnf-vqaaa-aaaar-qag4q-cai" },
  { key: "ICP",    id: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
  { key: "BOB",    id: "7pail-xaaaa-aaaas-aabmq-cai" },
];

type BalRow = { key: string; info: TokenInfo | null; main?: string; sub?: string; loading: boolean; err?: string | null; };

const toHex = (arr?: Uint8Array | null) => !arr ? "-" : Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
function CopyBtn({ text }: { text?: string }) { if (!text) return null; return (<button onClick={() => navigator.clipboard.writeText(text)} style={{ marginLeft: 8, fontSize: 12 }}>Copy</button>); }

export default function Assets() {
  const { identity, principalText } = useAuth();
  const [vaultId, setVaultId] = useState<string>("");
  const [sub32, setSub32] = useState<Uint8Array | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [accIdHex, setAccIdHex] = useState<string>("");

  const [rows, setRows] = useState<BalRow[]>(TOKENS.map(t => ({ key: t.key, info: null, loading: true })));

  // 加载 canisterId / 用户派生子账户（显式按 who 查询，避免匿名 caller 偏差）
  useEffect(() => {
    (async () => {
      try {
        const actAnon = (await getVaultpairActor(undefined)) as any;

        // 未登录：仅拿合约 principal；清空子账户/AI
        if (!identity || !principalText) {
          const p = await actAnon.get_canister_principal();
          const canisterId =
            typeof p === "string" ? p : (p as any).toText?.() || String(p);
          setVaultId(canisterId);
          setSub32(null);
          setAccIdHex("");
          return;
        }

        // 已登录：显式用 who 查询，避免依赖 caller 的 my_* 变成匿名
        const t = await get_deposit_target_for(principalText); // { owner, sub, ai_hex }
        const canisterId =
          typeof t.owner === "string"
            ? t.owner
            : (t as any).owner?.toText?.() || String((t as any).owner);

        setVaultId(canisterId);
        setSub32(Uint8Array.from(t.sub));
        setAccIdHex(String(t.ai_hex));
      } catch (e) {
        console.error("load vault/subaccount failed:", e);
      }
    })();
  }, [identity, principalText]);


  // 版本号用于丢弃过期结果，避免被“无子账户”的早期请求覆盖
  const reqVer = useRef(0);

  // 读取 token 元数据 & 余额（单 Agent + 全量并发 + 防竞态）
  useEffect(() => {
    if (!principalText || !vaultId) return;

    const myVer = ++reqVer.current;      // 本次请求的版本号
    (async () => {
      try {
        const agentQuery  = await createAgent(undefined);              // 匿名（读）
        const agentUpdate = await createAgent(identity || undefined);  // 带身份（写）

        const user  = Principal.fromText(principalText);
        const vault = Principal.fromText(vaultId);

        const tasks = TOKENS.map(async (t) => {
          const row: BalRow = { key: t.key, info: null, loading: true, err: null };
          try {
            const info = await readTokenInfoWithAgent(t.id, agentQuery);  // ← 匿名读
            row.info = info;

            const pMain = icrcBalanceOfWithAgent(t.id, { owner: user }, agentQuery);
            const pSub  = sub32
              ? icrcBalanceOfWithAgent(t.id, { owner: vault, subaccount: sub32 }, agentQuery)
              : Promise.resolve<bigint>(0n);

            const [nMain, nSub] = await Promise.all([pMain, pSub]);
            row.main = fromUnit(nMain, info.decimals);
            row.sub  = sub32 ? fromUnit(nSub, info.decimals) : "-";
            row.loading = false;
          } catch (e: any) {
            row.err = e?.message ?? String(e);
            row.loading = false;
          }
          return row;
        });


        const next = await Promise.all(tasks);

        // 仅当这仍是“最新的一轮”时才更新 UI，防止被过期结果覆盖
        if (reqVer.current === myVer) setRows(next);
      } catch (e) {
        if (reqVer.current === myVer) console.error("load balances failed:", e);
      }
    })();

    // 可选：unmount / 依赖变化时自然使旧请求过期（依赖 myVer 即可）
  }, [identity, principalText, vaultId, sub32, reloadKey]);


  /* -------- 资金转出（任意到任意） -------- */
  const [tokenKey, setTokenKey] = useState("ckUSDC");
  const [src, setSrc] = useState<"main"|"sub">("main");
  const [dest, setDest] = useState<string>("");
  const [destSubHex, setDestSubHex] = useState<string>("");
  const [amt, setAmt] = useState<string>("0");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  const tokenMap = useMemo(() => {
    const m = new Map<string, { id: string; info?: TokenInfo|null }>();
    TOKENS.forEach(t => m.set(t.key, { id: t.id, info: rows.find(r => r.key === t.key)?.info }));
    return m;
  }, [rows]);

  const doTransfer = async () => {
    setMsg("");
    if (!principalText) { setMsg("Please log in first"); return; }
    const meta = tokenMap.get(tokenKey);
    if (!meta || !meta.info) { setMsg("Token information not loaded"); return; }

    let to: { owner: Principal; subaccount?: Uint8Array|null } = { owner: Principal.fromText(dest.trim()) };
    if (destSubHex.trim()) {
      const hex = destSubHex.trim().toLowerCase().replace(/^0x/, "");
      if (hex.length !== 64) { setMsg("Target subaccount hex must be 32 bytes (64 hex characters)"); return; }
      const arr = new Uint8Array(32); for (let i=0;i<32;i++) arr[i] = parseInt(hex.slice(i*2, i*2+2), 16);
      to.subaccount = arr;
    }

    const amount = toUnit(amt, meta.info.decimals);
    setBusy(true);
    try {
      if (src === "main") {
        await icrc1Transfer(meta.id, null, to, amount, identity || undefined);
        setMsg("Transfer from main account successful");
      } else {
        await withdraw_from_sub(
          meta.id,
          { owner: to.owner, subaccount: to.subaccount ? Array.from(to.subaccount) : [] } as any,
          amount as unknown as bigint,
          identity || undefined
        );
        setMsg("Transfer from subaccount successful");
      }
      setReloadKey(k => k + 1);
    } catch (e:any) { setMsg(`Transfer failed: ${e?.message || String(e)}`); }
    finally { setBusy(false); }
  };

  /* -------- 主↔子 一键互转（真实代币） -------- */
  const [quickToken, setQuickToken] = useState("ICP");
  const [quickAmt, setQuickAmt] = useState("0.001");
  const quickInfo = rows.find(r => r.key === quickToken)?.info;
  const [quickBusy, setQuickBusy] = useState(false);


  const subHex = toHex(sub32);

  const depositToSub = async () => { // 主 -> 子
    setMsg("");
    if (!principalText || !sub32 || !quickInfo) return setMsg("Information not ready");
    try {
      await icrc1Transfer(
        TOKENS.find(t => t.key === quickToken)!.id,
        null,
        { owner: Principal.fromText(vaultId), subaccount: sub32 },
        toUnit(quickAmt, quickInfo.decimals),
        identity || undefined
      );
      setMsg("Deposit to subaccount successful");
      setReloadKey(k => k + 1);
    } catch (e:any) { setMsg(`Deposit to subaccount failed: ${e?.message || String(e)}`); }
  };

  const withdrawToMain = async () => { // 子 -> 主：常规=单 update；不足时再补授
    setMsg("");
    if (!principalText || !quickInfo) return setMsg("Information not ready");
    if (!sub32) return setMsg("Derived subaccount not detected");
    if (quickBusy) return;
    setQuickBusy(true);

    try {
      const tokenId = TOKENS.find(t => t.key === quickToken)!.id;
      const agent   = await createAgent(identity || undefined);
      const user    = Principal.fromText(principalText);
      const vault   = Principal.fromText(vaultId);
      const amount  = toUnit(quickAmt, quickInfo.decimals);

      // 直接尝试一次 transfer_from（理想路径=单 update ≈2s）
      await icrc2TransferFromWithAgent(
        tokenId,
        { owner: vault, subaccount: sub32 },
        { owner: user },
        amount,
        agent
      );
      setMsg("Withdraw to main account successful (ICRC-2: single update)");
    } catch (e:any) {
      const s = String(e?.message || e);

      // 仅在额度不足时，补做一次授权 + 重试（总共两次 update ≈4s）
      if (/InsufficientAllowance|allowance/i.test(s)) {
        try {
          setMsg("Detected insufficient allowance, automatically authorizing and retrying…");
          // 一次性授权得更大，后续长期走“单 update”；建议 1e4~1e6 倍
          const tokenId = TOKENS.find(t => t.key === quickToken)!.id;
          const amount  = toUnit(quickAmt, quickInfo.decimals);

          await ensure_allowance_for_user(
            tokenId,
            amount * 10_000n,     // 注意：后端会再 ×100，因此这里无需更大
            identity || undefined
          );

          // 授权完重试一次 transfer_from
          const agent2 = await createAgent(identity || undefined);
          await icrc2TransferFromWithAgent(
            tokenId,
            { owner: Principal.fromText(vaultId), subaccount: sub32 },
            { owner: Principal.fromText(principalText) },
            toUnit(quickAmt, quickInfo.decimals),
            agent2
          );

          setMsg("Withdraw to main account successful (authorized and retried)");
        } catch (e2:any) {
          setMsg(`Withdraw to main account failed: ${e2?.message || String(e2)}`);
        }
      } else {
        setMsg(`Withdraw to main account failed: ${s}`);
      }
    } finally {
      setQuickBusy(false);
      setReloadKey(k => k + 1);
    }
  };



  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section>
        <h3>Real Tokens (ICRC-1)</h3>
        <p style={{ opacity: 0.8, fontSize: 13 }}>
          Main Account ={" "}
          <a href={`https://www.icexplorer.io/address/details/${principalText || ""}`} target="_blank" rel="noreferrer">
            {principalText || "-"}
          </a>
          <CopyBtn text={principalText || ""} />
          ， Vault ID ={" "}
          <a href={`https://www.icexplorer.io/address/details/${vaultId || ""}`} target="_blank" rel="noreferrer">
            {vaultId || "-"}
          </a>
          <CopyBtn text={vaultId || ""} />
          ， ICP Recharge Address (AI) ={" "}
          <a href={`https://www.icexplorer.io/address/details/${accIdHex || ""}`} target="_blank" rel="noreferrer">
            {accIdHex || "-"}
          </a>
          <CopyBtn text={accIdHex || ""} />
          ， Derived Subaccount (32-byte hex) = <code>{subHex || "-"}</code>
        </p>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Token</th><th>Symbol</th><th>Decimals</th><th>Fee</th>
              <th>Main Balance</th><th>Sub-Account Balance</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td>{r.key}</td>
                <td>{r.info?.symbol ?? "-"}</td>
                <td>{r.info?.decimals ?? "-"}</td>
                <td>{r.info ? `${r.info.fee} (min unit)` : "-"}</td>
                <td>{r.loading ? "Loading..." : (r.main ?? "-")}</td>
                <td>{r.loading ? "Loading..." : (r.sub  ?? "-")}</td>
                <td>{r.err ? <span style={{color:"#f87171"}}>{r.err}</span> : "OK"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* 一键：主↔子互转 */}
      <section style={{ border: "1px solid #333", borderRadius: 8, padding: 12 }}>
        <h3>Main Account ↔ Subaccount Transfer (Real Tokens)</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 820 }}>
          <div>
            <label>Token:</label>{" "}
            <select value={quickToken} onChange={e => setQuickToken(e.target.value)}>
              {TOKENS.map(t => <option key={t.key} value={t.key}>{t.key}</option>)}
            </select>
            {"  "}
            <label>Amount (natural number):</label>{" "}
            <input value={quickAmt} onChange={e=>setQuickAmt(e.target.value)} style={{ width: 180 }} />
          </div>
          <div>
            <button onClick={depositToSub} disabled={!quickInfo || quickBusy}>Main → Sub (Deposit to Derived Subaccount)</button>{" "}
            <button onClick={withdrawToMain} disabled={!quickInfo || quickBusy}>Sub → Main (Withdraw from Subaccount)</button>
            {msg && <span style={{ marginLeft: 12 }}>{msg}</span>}
          </div>
          <div style={{ opacity:.8, fontSize:12 }}>
            Subaccount target: owner=<code>{vaultId}</code>, sub=<code>{subHex}</code>
          </div>
        </div>
      </section>

      {/* 任意转出 */}
      <section style={{ border: "1px solid #333", borderRadius: 8, padding: 12 }}>
        <h3>Transfer Out (to any principal / subaccount)</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 820 }}>
          <div>
            <label>Token:</label>{" "}
            <select value={tokenKey} onChange={e => setTokenKey(e.target.value)}>
              {TOKENS.map(t => <option key={t.key} value={t.key}>{t.key}</option>)}
            </select>
            {" "}
            <label>Source:</label>{" "}
            <select value={src} onChange={e => setSrc(e.target.value as any)}>
              <option value="main">Main Account (current II identity)</option>
              <option value="sub">Subaccount (contract custody)</option>
            </select>
          </div>
          <div>
            <label>Destination Principal:</label>{" "}
            <input style={{ width: 480 }} value={dest} onChange={e=>setDest(e.target.value)} placeholder="e.g., ryjl3-...-cai or ihy77-..." />
          </div>
          <div>
            <label>Destination Subaccount (optional, 64-char hex):</label>{" "}
            <input style={{ width: 480 }} value={destSubHex} onChange={e=>setDestSubHex(e.target.value)} placeholder="Leave empty = recipient main account; e.g., 32-byte HEX" />
          </div>
          <div>
            <label>Amount (natural number):</label>{" "}
            <input value={amt} onChange={e=>setAmt(e.target.value)} style={{ width: 180 }} />
          </div>
          <div>
            <button disabled={busy} onClick={doTransfer}>{busy ? "Submitting..." : "Submit Transfer"}</button>
            {msg && <span style={{ marginLeft: 12 }}>{msg}</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
