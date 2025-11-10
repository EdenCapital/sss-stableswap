// canisters/www/src/api/calls.ts
// @ts-ignore
import { idlFactory } from "../vaultpair.did.js";
import { Principal } from "@dfinity/principal";
import { createAgent } from "./actor";
import { HttpAgent, Actor } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";

/* ---------------- 基础 ---------------- */
const CANISTER_ID =
  (import.meta as any).env?.VITE_VAULTPAIR_ID || "<VAULTPAIR_CANISTER_ID>";

async function makeActor(identity?: any) {
  const agent = await createAgent(identity);
  return Actor.createActor(idlFactory as any, { agent, canisterId: CANISTER_ID });
}

/* ---------------- 公共工具 ---------------- */
// e6 ↔ 自然数
export const fromE6 = (x: number | bigint | string): number => Number(x) / 1e6;
export const toE6   = (x: number): bigint => BigInt(Math.round(x * 1e6));

// 任意 Nat(bigint/number/string) -> number
const natToNumber = (v: any) => Number(typeof v === "bigint" ? v : v ?? 0);

// 10^dec
const pow10 = (dec: number) => {
  let r = 1;
  for (let i = 0; i < dec; i++) r *= 10;
  return r;
};
// 外部最小单位 Nat → 自然数（按 decimals）
const fromExtNat = (n: any, dec: number) => natToNumber(n) / pow10(dec);
// 自然数 → 外部最小单位 Nat（按 decimals）
const toExtNat = (n: number, dec: number) => {
  const k = pow10(dec);
  return BigInt(Math.round((Number.isFinite(n) ? n : 0) * k));
};

// Token 相关类型（与后端保持一致）
export type Token = "USDC" | "USDT" | "BOB" | "ICP";
export const tokenToVariant = (t: Token) => ({ [t]: null } as any);
export type TokenId =
  | { USDC: null }
  | { USDT: null }
  | { BOB: null }
  | { ICP: null };

export type Account = { owner: string | Principal; subaccount?: any };
const accountOf = (o: string | Principal) => ({
  owner: typeof o === "string" ? Principal.fromText(o) : o,
  subaccount: [] as any,
});

/* ---------------- TokenMeta（用于 decimals 动态换算） ---------------- */
type TokenMeta = {
  ckusdc: Principal;
  ckusdt: Principal;
  dec_usdc: number; // nat8
  dec_usdt: number; // nat8
};
let _meta: TokenMeta | null = null;

// 兼容 opt 返回：[] | [val] | 直接对象
export async function get_token_meta(): Promise<TokenMeta | null> {
  const a = await makeActor();
  const raw = await (a as any).get_token_meta();
  const meta = Array.isArray(raw) ? (raw.length ? raw[0] : null) : raw ?? null;
  if (!meta) return null;

  const norm: TokenMeta = {
    ckusdc: typeof meta.ckusdc === "string" ? Principal.fromText(meta.ckusdc) : meta.ckusdc,
    ckusdt: typeof meta.ckusdt === "string" ? Principal.fromText(meta.ckusdt) : meta.ckusdt,
    dec_usdc: Number(meta.dec_usdc ?? 6),
    dec_usdt: Number(meta.dec_usdt ?? 6),
  };
  _meta = norm;
  return norm;
}

async function ensureMeta() {
  if (!_meta) await get_token_meta();
  if (!_meta) {
    // 兜底：当未设置时按 ckUSDC/ckUSDT 常见的 6
    _meta = {
      ckusdc: Principal.anonymous(),
      ckusdt: Principal.anonymous(),
      dec_usdc: 6,
      dec_usdt: 6,
    };
  }
}

/* ---------------- 资产页（保留原有） ---------------- */
export async function getUserBalances(p: Principal) {
  const a = await makeActor();
  const acc = accountOf(p);
  const r = await (a as any).get_user_balances(acc);
  return {
    usdc: Number(r[0]),
    usdt: Number(r[1]),
    bob: Number(r[2]),
    icp: Number(r[3]),
  };
}

export async function getUserSubBalances(p: Principal) {
  const a = await makeActor();
  const acc = accountOf(p);
  const list = (await (a as any).get_user_sub_balances(acc)) as Array<any>;
  const toNum = (v: any) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
  return list.map((x) => ({
    id: String(x.id),
    usdc: toNum(x.usdc),
    usdt: toNum(x.usdt),
    bob: toNum(x.bob),
    icp: toNum(x.icp),
  }));
}

/* ---------------- （旧）后台对账 API：仅保留以兼容其他页 ---------------- */
export async function sync_user_ledger_all(identity?: any): Promise<string> {
  const a = await makeActor(identity);
  const res = await (a as any).sync_user_ledger_all();
  if (typeof res === "string") return res;
  if (res && "ok" in res) return String(res.ok);
  if (res && "err" in res) throw new Error(String(res.err));
  return String(res);
}

/* ---------------- 新：非阻塞刷新 + 直读 live ---------------- */
// 触发后台刷新（非阻塞，立刻返回 "scheduled"）
export async function refresh_available_for(
  user: Principal,
  identity?: any
): Promise<"scheduled"> {
  const a = await makeActor(identity);
  const res = await (a as any).refresh_available_for(user);
  if (res && "ok" in res) return "scheduled";
  if (res && "err" in res) throw new Error(String(res.err));
  return "scheduled";
}

// 直接读取链上余额（Available：usdc/usdt 为 Nat 外部最小单位）→ 自然数
export async function get_available_balances_live_for(
  user: Principal
): Promise<{ usdc: number; usdt: number }> {
  await ensureMeta();
  const decU = _meta!.dec_usdc ?? 6;
  const decT = _meta!.dec_usdt ?? 6;

  const a = await makeActor();
  const r = await (a as any).get_available_balances_live_for(user);
  return {
    usdc: fromExtNat(r.usdc, decU),
    usdt: fromExtNat(r.usdt, decT),
  };
}

// 组合：触发刷新并轮询直读
export async function refresh_and_poll_available(
  user: Principal,
  opts?: { tries?: number; intervalMs?: number },
  identity?: any
): Promise<{ usdc: number; usdt: number }> {
  const tries = Math.max(1, opts?.tries ?? 12);
  const interval = Math.max(200, opts?.intervalMs ?? 1000);
  await refresh_available_for(user, identity);

  let last = await get_available_balances_live_for(user);
  for (let i = 1; i < tries; i++) {
    await new Promise((r) => setTimeout(r, interval));
    const cur = await get_available_balances_live_for(user);
    if (cur.usdc !== last.usdc || cur.usdt !== last.usdt) {
      last = cur;
      break;
    }
  }
  return last;
}

/* ---------------- ICRC/账户辅助（保留） ---------------- */
export async function get_my_deposit_target(identity?: any): Promise<{
  owner: string | Principal;   // 兼容 principal 返回
  sub: number[];
  ai_hex: string;
}> {
  // 用带身份的 actor，避免匿名 caller 产生“匿名子账户”
  const a = await makeActor(identity);
  return (a as any).get_my_deposit_target();
}


export async function get_deposit_target_for(
  user: string | Principal
): Promise<{ owner: string; sub: number[]; ai_hex: string }> {
  const a = await makeActor();
  const p = typeof user === "string" ? Principal.fromText(user) : user;
  return (a as any).get_deposit_target_for(p);
}

export async function get_my_icp_account_id_hex() {
  const a = await makeActor();
  return (a as any).get_my_icp_account_id_hex() as Promise<string>;
}

export async function ensure_allowance_for_user(
  tokenCanisterId: string,
  min_amount_e0: bigint,
  identity?: any
): Promise<boolean> {
  const a = await makeActor(identity);
  const tokenPrin = Principal.fromText(tokenCanisterId);
  const ok = await (a as any).ensure_allowance_for_user(tokenPrin, min_amount_e0);
  return Boolean(ok);
}

/* ---------------- Swap：改用 quote_live / swap_live ---------------- */
export async function quote(token_in: TokenId, token_out: TokenId, dxNat: number) {
  const a = await makeActor();
  return (a as any).quote_live(token_in, token_out, toE6(dxNat));
}

export async function swap(args: {
  account: { owner: string | Principal; subaccount?: any };
  token_in: TokenId;
  token_out: TokenId;
  dx_e6: number;      // 自然数口径，例如 10.5
  min_dy_e6?: number; // 自然数口径
}) {
  const a = await makeActor();
  const acc = accountOf(args.account.owner);
  const res = await (a as any).swap_live({
    account: acc,
    token_in: args.token_in,
    token_out: args.token_out,
    dx_e6: toE6(args.dx_e6),
    min_dy_e6: toE6(args.min_dy_e6 ?? 0),
  });
  if (res && "ok" in res) return res.ok;
  if (res && "err" in res) throw new Error(String(res.err));
  return res;
}

/* ---------------- 流动性页 ---------------- */
export type PoolInfo = {
  a_amp: number; fee_bps: number;
  reserve_usdc: number; reserve_usdt: number;
  total_shares: number; virtual_price_e6: number;
};

export async function get_pool_info(): Promise<PoolInfo> {
  const a = await makeActor();
  const r = await (a as any).get_pool_info();
  return {
    a_amp: Number(r.a_amp),
    fee_bps: Number(r.fee_bps),
    reserve_usdc: Number(r.reserve_usdc),
    reserve_usdt: Number(r.reserve_usdt),
    total_shares: Number(r.total_shares),
    virtual_price_e6: Number(r.virtual_price_e6),
  };
}

export async function get_user_position(account: Account): Promise<number> {
  const a = await makeActor();
  const acc = accountOf(account.owner);
  const r = await (a as any).get_user_position(acc);
  const shares = (r && (r.shares ?? r)) || 0;
  return Number(shares) / 1_000_000;
}

export async function get_unclaimed_fee(account: Account): Promise<{ usdc: number; usdt: number }> {
  const a = await makeActor();
  const acc = accountOf(account.owner);
  const r = await (a as any).get_unclaimed_fee(acc);
  const toNum = (x: any) => Number(typeof x === "bigint" ? x : x ?? 0) / 1_000_000;
  return { usdc: toNum(r.usdc), usdt: toNum(r.usdt) };
}

export async function add_liquidity(
  account: Account,
  usdcNat: number,
  usdtNat: number,
  identity?: any
): Promise<number> {
  const a = await makeActor(identity);
  const acc = accountOf(account.owner);
  const r = await (a as any).add_liquidity(acc, toE6(usdcNat), toE6(usdtNat));
  const ok = (r && "ok" in r) ? r.ok : r;
  const shares = (ok && ok.shares) || ok || 0n;
  return Number(shares) / 1_000_000;
}

export async function remove_liquidity(
  account: Account,
  sharesNat: number,
  identity?: any
): Promise<{ usdc: number; usdt: number }> {
  const a = await makeActor(identity);
  const acc = accountOf(account.owner);
  const r = await (a as any).remove_liquidity(acc, toE6(sharesNat));
  const ok = (r && "ok" in r) ? r.ok : r;
  const toNum = (x: any) => Number(typeof x === "bigint" ? x : x ?? 0) / 1_000_000;
  return { usdc: toNum(ok.usdc), usdt: toNum(ok.usdt) };
}

// 领取手续费
export async function claim_fee(
  account: Account,
  identity?: any
): Promise<{ usdc: number; usdt: number }> {
  const a = await makeActor(identity);
  const acc = {
    owner: typeof account.owner === "string"
      ? Principal.fromText(account.owner)
      : account.owner,
    subaccount: [] as any,
  };
  const r = await (a as any).claim_fee(acc);
  const ok = (r && "ok" in r) ? r.ok : r;
  const toNum = (x: any) => Number(typeof x === "bigint" ? x : x ?? 0) / 1_000_000;
  return { usdc: toNum(ok.usdc), usdt: toNum(ok.usdt) };
}

/* ---------------- ICRC Ledger 访问（余额、转账） ---------------- */
const ICRC1_IDL = ({ IDL }: any) =>
  IDL.Service({
    icrc1_balance_of: IDL.Func(
      [IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
      [IDL.Nat],
      ["query"]
    ),
    icrc1_decimals: IDL.Func([], [IDL.Nat8], ["query"]),
    icrc1_transfer: IDL.Func(
      [
        IDL.Record({
          memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
          amount: IDL.Nat,
          fee: IDL.Opt(IDL.Nat),
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          to: IDL.Record({
            owner: IDL.Principal,
            subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          }),
          created_at_time: IDL.Opt(IDL.Nat64),
        }),
      ],
      [
        IDL.Variant({
          Ok: IDL.Nat,
          Err: IDL.Variant({
            BadFee: IDL.Record({ expected_fee: IDL.Nat }),
            BadBurn: IDL.Record({ min_burn_amount: IDL.Nat }),
            InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
            TooOld: IDL.Null,
            CreatedInFuture: IDL.Null,
            Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
            TemporarilyUnavailable: IDL.Null,
            GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
          }),
        }),
      ],
      []
    ),
  });



async function makeLedger(canisterId: string | Principal, identity?: any) {
  // 统一为字符串，避免下游对 canisterId 调用 .includes 时类型不匹配
  const cid = typeof canisterId === "string" ? canisterId : canisterId.toText();

  // 带上 identity，确保 icrc1_transfer 以用户主账户签名发起
  const agent = new HttpAgent({ host: window.location.origin, identity });
  if (location.hostname.endsWith("localhost")) {
    await agent.fetchRootKey();
  }
  return Actor.createActor(ICRC1_IDL, { agent, canisterId: cid });
}


// === 充值：主账户 → 派生子账户（Deposit） ===
export async function deposit_to_my_sub(
  tokenLedgerId: string | Principal,
  amount_nat: number, // 自然数
  dec: number,        // 对应 token 的 decimals
  identity?: any
): Promise<bigint> {
  // 用用户身份创建 ledger，确保从“主账户”转出
  const ledger = await makeLedger(tokenLedgerId, identity);

  // ① 优先：用“当前登录用户”的 principal 显式查询其派生子账户（与 Assets 页一致）
  // ② 退路：若 identity 不可用，则回退到 get_my_deposit_target(identity)
  let ownerPrin: Principal;
  let subArr: number[];

  try {
    const who: Principal | null =
      identity?.getPrincipal ? identity.getPrincipal() : null;

    if (who) {
      // 与 Assets 页同源：显式按用户 principal 读取
      const t = await get_deposit_target_for(who);
      ownerPrin = typeof t.owner === "string" ? Principal.fromText(t.owner) : (t.owner as Principal);
      subArr   = t.sub;
    } else {
      // 无法获取 principal 时，退回“按 caller”的接口，但也带上 identity
      const t = await get_my_deposit_target(identity);
      ownerPrin = typeof t.owner === "string" ? Principal.fromText(t.owner) : (t.owner as Principal);
      subArr   = t.sub;
    }
  } catch (e) {
    // 极端情况下的兜底（仍用 get_my_deposit_target(identity)）
    const t = await get_my_deposit_target(identity);
    ownerPrin = typeof t.owner === "string" ? Principal.fromText(t.owner) : (t.owner as Principal);
    subArr   = t.sub;
  }

  const toAcc = {
    owner: ownerPrin,
    // ICRC-1: subaccount = Opt<Vec<u8>>，空数组表示 None，单元素表示 Some(Uint8Array(32))
    subaccount: [Uint8Array.from(subArr)],
  } as const;

  const amount_e0 = toExtNat(amount_nat, dec);

  const res = await (ledger as any).icrc1_transfer({
    to: toAcc,
    amount: amount_e0,
    fee: [],             // 用默认费率
    memo: [],
    from_subaccount: [], // 主账户转出
    created_at_time: [],
  });

  if (res?.Ok !== undefined) return BigInt(res.Ok);
  if (res?.Err) throw new Error(JSON.stringify(res.Err));
  throw new Error("unexpected result from icrc1_transfer");
}



// 便捷包装：ckUSDC / ckUSDT 充值到派生子账户
export async function deposit_ckusdc_to_my_sub(amount_nat: number, identity?: any): Promise<bigint> {
  await ensureMeta();
  return deposit_to_my_sub(_meta!.ckusdc, amount_nat, _meta!.dec_usdc, identity);
}
export async function deposit_ckusdt_to_my_sub(amount_nat: number, identity?: any): Promise<bigint> {
  await ensureMeta();
  return deposit_to_my_sub(_meta!.ckusdt, amount_nat, _meta!.dec_usdt, identity);
}

/* ---------------- 池子储备（live）与对齐 ---------------- */
export async function get_pool_reserves_live(): Promise<{ usdc: number; usdt: number }> {
  await ensureMeta();
  const decU = _meta!.dec_usdc ?? 6;
  const decT = _meta!.dec_usdt ?? 6;

  const a = await makeActor();
  const r = await (a as any).get_pool_reserves_live(); // { usdc: Nat, usdt: Nat }
  const toBig = (v: any) => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

  const usdcNat = toBig(r?.usdc);
  const usdtNat = toBig(r?.usdt);

  return {
    usdc: Number(usdcNat) / 10 ** decU,
    usdt: Number(usdtNat) / 10 ** decT,
  };
}

export async function admin_reconcile_pool_from_live(identity?: any): Promise<string> {
  const a = await makeActor(identity);
  const r = await (a as any).admin_reconcile_pool_from_live();
  if (typeof r === "string") return r;
  if (r && "ok" in r) return String(r.ok);
  if (r && "err" in r) throw new Error(String(r.err));
  return String(r);
}

/* ---------------- Events（转为前端友好结构） ---------------- */
export type EventUI =
  | { kind: "Swap";       who: string; ts: number; dx: number; dy: number }
  | { kind: "AddLiq";     who: string; ts: number; usdc: number; usdt: number; shares: number }
  | { kind: "RemoveLiq";  who: string; ts: number; usdc: number; usdt: number; shares: number }
  | { kind: "Deposit";    who: string; ts: number; token: "ckUSDC" | "ckUSDT"; amount: number }
  | { kind: "Withdraw";   who: string; ts: number; token: "ckUSDC" | "ckUSDT"; amount: number }
  | { kind: "ClaimFee";   who: string; ts: number; usdc: number; usdt: number }; // 若后端已加

function tokenNameOf(t: any): "ckUSDC" | "ckUSDT" {
  if (t && typeof t === "object") {
    if ("USDC" in t) return "ckUSDC";
    if ("USDT" in t) return "ckUSDT";
  }
  return "ckUSDC";
}

function normalizeTsMs(ts: any): number {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 统一转换为毫秒
  if (n >= 1e18) return Math.floor(n / 1e6); // ns -> ms
  if (n >= 1e15) return Math.floor(n / 1e3); // µs -> ms
  if (n >= 1e12) return Math.floor(n);       // 已是 ms
  return Math.floor(n * 1000);               // sec -> ms
}


function normalizeEvent(e: any): EventUI | null {
  if (!e) return null;

  // 已扁平（有 kind）的情形
  if (e.kind) {
    switch (e.kind) {
      case "Swap":
        return { kind: "Swap", who: e.who, ts: normalizeTsMs(e.ts), dx: Number(e.dx), dy: Number(e.dy) };
      case "AddLiq":
        return { kind: "AddLiq", who: e.who, ts: normalizeTsMs(e.ts), usdc: Number(e.usdc), usdt: Number(e.usdt), shares: Number(e.shares) };
      case "RemoveLiq":
        return { kind: "RemoveLiq", who: e.who, ts: normalizeTsMs(e.ts), usdc: Number(e.usdc), usdt: Number(e.usdt), shares: Number(e.shares) };
      case "Deposit":
        return { kind: "Deposit", who: e.who, ts: normalizeTsMs(e.ts), token: tokenNameOf(e.token), amount: Number(e.amount) };
      case "Withdraw":
        return { kind: "Withdraw", who: e.who, ts: normalizeTsMs(e.ts), token: tokenNameOf(e.token), amount: Number(e.amount) };
      case "ClaimFee":
        return { kind: "ClaimFee", who: e.who, ts: normalizeTsMs(e.ts), usdc: Number(e.usdc), usdt: Number(e.usdt) };
      default:
        return null;
    }
  }

  // candid variant 形态
  if (e.Swap) {
    const v = e.Swap;
    return { kind: "Swap", who: String(v.who), ts: normalizeTsMs(v.ts), dx: fromE6(v.dx_e6), dy: fromE6(v.dy_e6) };
  }
  if (e.AddLiq) {
    const v = e.AddLiq;
    return { kind: "AddLiq", who: String(v.who), ts: normalizeTsMs(v.ts), usdc: fromE6(v.usdc), usdt: fromE6(v.usdt), shares: fromE6(v.shares) };
  }
  if (e.RemoveLiq) {
    const v = e.RemoveLiq;
    return { kind: "RemoveLiq", who: String(v.who), ts: normalizeTsMs(v.ts), usdc: fromE6(v.usdc), usdt: fromE6(v.usdt), shares: fromE6(v.shares) };
  }
  if (e.Deposit) {
    const v = e.Deposit;
    return { kind: "Deposit", who: String(v.who), ts: normalizeTsMs(v.ts), token: tokenNameOf(v.token), amount: fromE6(v.amount) };
  }
  if (e.Withdraw) {
    const v = e.Withdraw;
    return { kind: "Withdraw", who: String(v.who), ts: normalizeTsMs(v.ts), token: tokenNameOf(v.token), amount: fromE6(v.amount) };
  }
  if (e.ClaimFee) {
    const v = e.ClaimFee;
    return { kind: "ClaimFee", who: String(v.who), ts: normalizeTsMs(v.ts), usdc: fromE6(v.usdc_e6), usdt: fromE6(v.usdt_e6) };
  }
  return null;
}


export async function get_events(
  cursor: bigint | number | string,
  limit: bigint | number | string,
  identity?: any
): Promise<EventUI[]> {
  const a = await makeActor(identity);
  const cur = typeof cursor === "bigint" ? cursor : BigInt(String(cursor));
  const lim = typeof limit === "bigint" ? limit : BigInt(String(limit));
  const res = await (a as any).get_events(cur, lim);
  const arr = Array.isArray(res) ? res : [];
  const out = arr.map(normalizeEvent).filter(Boolean) as EventUI[];

  // 过滤掉 2025-01-01 00:00:00（JST）之前的
  const CUTOFF_MS = Date.UTC(2024, 11, 31, 15, 0, 0); // 2024-12-31 15:00:00 UTC = 2025-01-01 00:00:00 JST
  return out
    .filter(ev => Number.isFinite(ev.ts) && ev.ts >= CUTOFF_MS)
    .sort((a, b) => b.ts - a.ts);
}

export async function get_events_latest(
  limit: bigint | number | string,
  identity?: any
): Promise<EventUI[]> {
  const a = await makeActor(identity);
  const lim = typeof limit === "bigint" ? limit : BigInt(String(limit));
  const res = await (a as any).get_events_latest(lim);
  const arr = Array.isArray(res) ? res : [];
  const out = arr.map(normalizeEvent).filter(Boolean) as EventUI[];

  const CUTOFF_MS = Date.UTC(2024, 11, 31, 15, 0, 0); // JST 截止线
  return out
    .filter(ev => Number.isFinite(ev.ts) && ev.ts >= CUTOFF_MS)
    .sort((a, b) => b.ts - a.ts);
}


/* ---------------- 其它（池子子 ↔ 用户子，保留） ---------------- */
// 用户子 -> 池子子
export async function transfer_from_user_sub_to_pool(
  tokenLedgerId: string,
  user: string | Principal,
  amount_e6: bigint | number | string,
  identity?: any
): Promise<bigint> {
  const a = await makeActor(identity);
  const userPrin = typeof user === "string" ? Principal.fromText(user) : user;
  const nat = typeof amount_e6 === "bigint" ? amount_e6 : BigInt(String(amount_e6));
  const res = await (a as any).transfer_from_user_sub_to_pool(tokenLedgerId, userPrin, nat);
  if (res && "ok" in res) return BigInt(res.ok);
  if (res && "err" in res) throw new Error(String(res.err));
  throw new Error("unexpected result from transfer_from_user_sub_to_pool");
}

// 池子子 -> 用户子
export async function transfer_from_pool_to_user_sub(
  tokenLedgerId: string,
  user: string | Principal,
  amount_e6: bigint | number | string,
  identity?: any
): Promise<bigint> {
  const a = await makeActor(identity);
  const userPrin = typeof user === "string" ? Principal.fromText(user) : user;
  const nat = typeof amount_e6 === "bigint" ? amount_e6 : BigInt(String(amount_e6));
  const res = await (a as any).transfer_from_pool_to_user_sub(tokenLedgerId, userPrin, nat);
  if (res && "ok" in res) return BigInt(res.ok);
  if (res && "err" in res) throw new Error(String(res.err));
  throw new Error("unexpected result from transfer_from_pool_to_user_sub");
}

// ICRC-1 提现（用户子 -> 任意账户）
export async function withdraw_from_sub(
  tokenCanisterId: string,
  to: { owner: string | Principal; subaccount?: number[] | Uint8Array | null },
  amount_e0: bigint | number | string,
  identity?: any
): Promise<string> {
  const a = await makeActor(identity);
  const ownerPrin =
    typeof to.owner === "string" ? Principal.fromText(to.owner) : to.owner;
  const toAcc: any = {
    owner: ownerPrin,
    subaccount:
      to.subaccount && (to.subaccount as any).length
        ? [Uint8Array.from(to.subaccount as any)]
        : [],
  };
  const nat =
    typeof amount_e0 === "bigint" ? amount_e0 : BigInt(String(amount_e0));
  const res = await (a as any).withdraw_from_sub(tokenCanisterId, toAcc, nat);
  if (res && "ok" in res) return String(res.ok);
  if (res && "err" in res) throw new Error(String(res.err));
  return String(res);
}

// === 统计：24h/7d 快照（供 Liquidity/Explore 使用） ===
export type StatsSnapshotUI = {
  now_sec: number;
  tvl: number;
  vol24h: number;
  vol7d: number;
  fee24h: number;
  fee7d: number;
  swaps24h: number;
  apy24h_pct: number;
};

export async function get_stats_snapshot(): Promise<StatsSnapshotUI> {
  const a = await makeActor();
  const s: any = await (a as any).get_stats_snapshot();
  const toNum = (v: any) => Number(typeof v === "bigint" ? v : v ?? 0);

  let now_sec: any, tvl_e6: any, vol_24h_e6: any, vol_7d_e6: any,
      fee_24h_e6: any, fee_7d_e6: any, swaps_24h: any, apy_24h_bp: any;

  if (s && "now_sec" in s) {
    ({ now_sec, tvl_e6, vol_24h_e6, vol_7d_e6, fee_24h_e6, fee_7d_e6, swaps_24h, apy_24h_bp } = s);
  } else {
    const vals = Object.values(s ?? {});
    [now_sec, tvl_e6, vol_24h_e6, vol_7d_e6, fee_24h_e6, fee_7d_e6, swaps_24h, apy_24h_bp] = vals;
  }

  return {
    now_sec:     toNum(now_sec),
    tvl:         toNum(tvl_e6)      / 1_000_000,
    vol24h:      toNum(vol_24h_e6)  / 1_000_000,
    vol7d:       toNum(vol_7d_e6)   / 1_000_000,
    fee24h:      toNum(fee_24h_e6)  / 1_000_000,
    fee7d:       toNum(fee_7d_e6)   / 1_000_000,
    swaps24h:    Number(swaps_24h ?? 0),
    apy24h_pct:  Number(apy_24h_bp ?? 0) / 100,
  };
}

export function toErrMsg(e: unknown): string {
  try {
    if (e == null) return '未知错误';
    if (typeof e === 'string') return e;
    const any = e as any;
    if (typeof any.message === 'string') return any.message;
    if (typeof any.Text === 'string') return any.Text;        // candid 常见
    if (any?.Err && typeof any.Err === 'string') return any.Err;
    return JSON.stringify(any);
  } catch {
    return String(e);
  }
}

export function strIncludes(hay: unknown, needle: string): boolean {
  if (typeof hay === 'string') return hay.includes(needle);
  const any = hay as any;
  if (typeof any?.message === 'string') return any.message.includes(needle);
  return false;
}
