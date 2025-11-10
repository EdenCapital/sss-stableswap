// canisters/www/src/api/token.ts
import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createAgent } from "./actor";


/* ============ ICRC-1 通用 IDL（含 transfer） ============ */
function idlIcrc1({ IDL: I }: { IDL: typeof IDL }) {
  const Account = I.Record({
    owner: I.Principal,
    subaccount: I.Opt(I.Vec(I.Nat8)),
  });

  const Value = I.Variant({
    Nat: I.Nat,
    Int: I.Int,
    Text: I.Text,
    Blob: I.Vec(I.Nat8),
    Bool: I.Bool,
    Nat8: I.Nat8,
  });

  const TransferArg = I.Record({
    from_subaccount: I.Opt(I.Vec(I.Nat8)),
    to: Account,
    amount: I.Nat,
    fee: I.Opt(I.Nat),
    memo: I.Opt(I.Vec(I.Nat8)),
    created_at_time: I.Opt(I.Nat64), // ns
  });

  const TransferError = I.Variant({
    BadFee: I.Record({ expected_fee: I.Nat }),
    BadBurn: I.Record({ min_burn_amount: I.Nat }),
    InsufficientFunds: I.Record({ balance: I.Nat }),
    TooOld: I.Null,
    CreatedInFuture: I.Record({ ledger_time: I.Nat64 }),
    TemporarilyUnavailable: I.Null,
    Duplicate: I.Record({ duplicate_of: I.Nat }),
    GenericError: I.Record({ error_code: I.Nat, message: I.Text }),
  });

  return I.Service({
    icrc1_name: I.Func([], [I.Text], ["query"]),
    icrc1_symbol: I.Func([], [I.Text], ["query"]),
    icrc1_decimals: I.Func([], [I.Nat8], ["query"]),
    icrc1_fee: I.Func([], [I.Nat], ["query"]),
    icrc1_metadata: I.Func([], [I.Vec(I.Tuple(I.Text, Value))], ["query"]),
    icrc1_balance_of: I.Func([Account], [I.Nat], ["query"]),
    icrc1_supported_standards: I.Func([], [I.Vec(I.Record({ name: I.Text, url: I.Text }))], ["query"]),
    icrc1_transfer: I.Func([TransferArg], [I.Variant({ Ok: I.Nat, Err: TransferError })], []),
  });
}

/* ============ 公共类型/工具 ============ */
export type TokenInfo = {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  fee: bigint;
};

export type IcrcAccount = {
  owner: Principal;
  subaccount?: Uint8Array | null;
};

export function createTokenActor(canisterId: string, agent?: HttpAgent) {
  const a = agent ?? new HttpAgent({ host: "https://icp0.io" });
  return Actor.createActor(idlIcrc1 as any, { agent: a, canisterId }) as any;
}

/* ============ 元数据缓存（5 分钟） ============ */
const META_TTL_MS = 5 * 60 * 1000;
const metaCache = new Map<string, { at: number; info: TokenInfo }>();

function getMetaCached(id: string): TokenInfo | null {
  const hit = metaCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > META_TTL_MS) { metaCache.delete(id); return null; }
  return hit.info;
}
function setMetaCached(info: TokenInfo) {
  metaCache.set(info.id, { at: Date.now(), info });
}

/* ============ 高效版本：使用已构建的 Agent（建议优先使用） ============ */
export async function readTokenInfoWithAgent(canisterId: string, agent: HttpAgent): Promise<TokenInfo> {
  const cached = getMetaCached(canisterId);
  if (cached) return cached;

  const actor = createTokenActor(canisterId, agent);

  let symbol = "", name = ""; let decimals = 0; let fee = 0n;
  try { symbol = await actor.icrc1_symbol(); } catch {}
  try { name = await actor.icrc1_name(); } catch {}
  try { decimals = Number(await actor.icrc1_decimals()); } catch {}
  try { fee = await actor.icrc1_fee(); } catch {}

  if (!symbol || !name || !decimals || fee === 0n) {
    try {
      const md: Array<[string, any]> = await actor.icrc1_metadata();
      for (const [k, v] of md) {
        if (!symbol && k === "icrc1:symbol" && "Text" in v) symbol = v.Text;
        if (!name && k === "icrc1:name"   && "Text" in v) name   = v.Text;
        if (!decimals && k === "icrc1:decimals" && "Nat8" in v) decimals = Number(v.Nat8);
        if (fee === 0n && k === "icrc1:fee" && "Nat" in v) fee = BigInt(v.Nat);
      }
    } catch {}
  }

  if (!symbol) symbol = "UNKNOWN";
  if (!name)   name   = symbol;

  const info = { id: canisterId, symbol, name, decimals, fee };
  setMetaCached(info);
  return info;
}

export async function icrcBalanceOfWithAgent(
  canisterId: string,
  account: IcrcAccount,
  agent: HttpAgent
): Promise<bigint> {
  const actor = createTokenActor(canisterId, agent);
  const arg = {
    owner: account.owner,
    subaccount: account.subaccount ? [Array.from(account.subaccount)] : [],
  };
  return await actor.icrc1_balance_of(arg);
}

/* ============ 兼容原有导出（内部自己建 Agent） ============ */
export async function readTokenInfo(canisterId: string, identity?: Identity): Promise<TokenInfo> {
  const agent = await createAgent(identity);
  return readTokenInfoWithAgent(canisterId, agent);
}

export async function icrcBalanceOf(
  canisterId: string,
  account: IcrcAccount,
  identity?: Identity
): Promise<bigint> {
  const agent = await createAgent(identity);
  return icrcBalanceOfWithAgent(canisterId, account, agent);
}

/* ============ 额度换算 ============ */
export function toUnit(n: number | string, decimals: number): bigint {
  const d = BigInt(decimals);
  const s = typeof n === "number" ? n.toString() : n;
  if (!s.includes(".")) return BigInt(s) * 10n ** d;
  const [i, f] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(i || "0") * 10n ** d + BigInt(frac || "0");
}
export function fromUnit(n: bigint, decimals: number): string {
  const d = BigInt(decimals);
  const den = 10n ** d;
  const i = n / den;
  const f = n % den;
  const fstr = f.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fstr.length ? `${i.toString()}.${fstr}` : i.toString();
}

/* ============ ICRC-1 转账（主账户→任意） ============ */
export async function icrc1Transfer(
  canisterId: string,
  fromSub: Uint8Array | null,
  to: IcrcAccount,
  amount: bigint,
  identity?: Identity,
  memo?: Uint8Array | null
): Promise<bigint> {
  const agent = await createAgent(identity);
  const actor = createTokenActor(canisterId, agent);

  const arg = {
    from_subaccount: fromSub ? [Array.from(fromSub)] : [],
    to: { owner: to.owner, subaccount: to.subaccount ? [Array.from(to.subaccount)] : [] },
    amount,
    fee: [],
    memo: memo ? [Array.from(memo)] : [],
    created_at_time: [BigInt(Date.now()) * 1_000_000n],
  };

  const res = await actor.icrc1_transfer(arg);
  if ("Ok" in res) return BigInt(res.Ok as any);

  const err = res.Err;
  if ("InsufficientFunds" in err) throw new Error(`InsufficientFunds: balance=${err.InsufficientFunds.balance.toString()}`);
  if ("BadFee"           in err) throw new Error(`BadFee: expected=${err.BadFee.expected_fee.toString()}`);
  if ("TooOld"           in err) throw new Error("TooOld");
  if ("CreatedInFuture"  in err) throw new Error("CreatedInFuture");
  if ("Duplicate"        in err) throw new Error(`Duplicate of ${err.Duplicate.duplicate_of.toString()}`);
  if ("GenericError"     in err) throw new Error(`${err.GenericError.error_code.toString()}: ${err.GenericError.message}`);
  throw new Error("Unknown transfer error");
}

/* ================= ICRC-2 扩展：allowance / approve / transfer_from ================= */
function idlIcrc2({ IDL: I }: { IDL: typeof IDL }) {
  const Account = I.Record({ owner: I.Principal, subaccount: I.Opt(I.Vec(I.Nat8)) });

  const ApproveArgs = I.Record({
    from_subaccount: I.Opt(I.Vec(I.Nat8)),
    spender: Account,
    amount: I.Nat,
    expected_allowance: I.Opt(I.Nat),
    expires_at: I.Opt(I.Nat64),
    fee: I.Opt(I.Nat),
    memo: I.Opt(I.Vec(I.Nat8)),
    created_at_time: I.Opt(I.Nat64),
  });

  const TransferFromArgs = I.Record({
    spender_subaccount: I.Opt(I.Vec(I.Nat8)),
    from: Account,
    to: Account,
    amount: I.Nat,
    fee: I.Opt(I.Nat),
    memo: I.Opt(I.Vec(I.Nat8)),
    created_at_time: I.Opt(I.Nat64),
  });

  const TxError = I.Variant({
    InsufficientAllowance: I.Record({ allowance: I.Nat }),
    InsufficientFunds: I.Record({ balance: I.Nat }),
    BadFee: I.Record({ expected_fee: I.Nat }),
    TooOld: I.Null,
    CreatedInFuture: I.Record({ ledger_time: I.Nat64 }),
    Duplicate: I.Record({ duplicate_of: I.Nat }),
    TemporarilyUnavailable: I.Null,
    GenericError: I.Record({ error_code: I.Nat, message: I.Text }),
    Unauthorized: I.Null,
  });

  return I.Service({
    // 查询某账户(owner/sub) 授予某 spender 的剩余额度
    icrc2_allowance: I.Func([I.Record({ account: Account, spender: Account })],
                            [I.Record({ allowance: I.Nat, expires_at: I.Opt(I.Nat64) })], ["query"]),
    // 代表 owner/sub 授权给某 spender（仅后端合约能做）
    icrc2_approve: I.Func([ApproveArgs], [I.Variant({ Ok: I.Nat, Err: TxError })], []),
    // spender 主动从 from 扣到 to
    icrc2_transfer_from: I.Func([TransferFromArgs], [I.Variant({ Ok: I.Nat, Err: TxError })], []),
    icrc1_supported_standards: I.Func([], [I.Vec(I.Record({ name: I.Text, url: I.Text }))], ["query"]),
  });
}

function createIcrc2Actor(canisterId: string, agent: HttpAgent) {
  // 与 ICRC-1 复用同一个 actor 工厂也可以；单独建一个更直观
  return Actor.createActor(idlIcrc2 as any, { agent, canisterId }) as any;
}

export async function icrc2Supported(canisterId: string, agent: HttpAgent): Promise<boolean> {
  try {
    const a = createIcrc2Actor(canisterId, agent);
    const stds: Array<{name: string; url: string}> = await a.icrc1_supported_standards();
    return stds?.some(s => (s.name || "").toUpperCase().includes("ICRC-2"));
  } catch { return false; }
}

export async function icrc2AllowanceWithAgent(
  canisterId: string,
  owner: IcrcAccount,       // 被扣方：{owner=vaultpair, sub=sub32}
  spender: IcrcAccount,     // 扣款人：{owner=user}
  agent: HttpAgent
): Promise<bigint> {
  const a = createIcrc2Actor(canisterId, agent);
  const arg = {
    account: { owner: owner.owner, subaccount: owner.subaccount ? [Array.from(owner.subaccount)] : [] },
    spender: { owner: spender.owner, subaccount: spender.subaccount ? [Array.from(spender.subaccount)] : [] },
  };
  const r = await a.icrc2_allowance(arg);
  return BigInt(r?.allowance ?? 0n);
}

export async function icrc2TransferFromWithAgent(
  canisterId: string,
  from: IcrcAccount,        // {owner=vaultpair, sub=sub32}
  to: IcrcAccount,          // {owner=user}
  amount: bigint,
  agent: HttpAgent
): Promise<bigint> {
  const a = createIcrc2Actor(canisterId, agent);
  const arg = {
    spender_subaccount: [], // 默认无
    from: { owner: from.owner, subaccount: from.subaccount ? [Array.from(from.subaccount)] : [] },
    to:   { owner: to.owner,   subaccount: to.subaccount   ? [Array.from(to.subaccount)]   : [] },
    amount,
    fee: [],
    memo: [],
    created_at_time: [BigInt(Date.now()) * 1_000_000n],
  };
  const res = await a.icrc2_transfer_from(arg);
  if ("Ok" in res) return BigInt(res.Ok as any);
  const e = res.Err;
  if ("InsufficientAllowance" in e) throw new Error(`InsufficientAllowance: ${e.InsufficientAllowance.allowance.toString()}`);
  if ("InsufficientFunds"     in e) throw new Error(`InsufficientFunds: ${e.InsufficientFunds.balance.toString()}`);
  if ("BadFee"                in e) throw new Error(`BadFee: ${e.BadFee.expected_fee.toString()}`);
  if ("TooOld"                in e) throw new Error("TooOld");
  if ("CreatedInFuture"       in e) throw new Error("CreatedInFuture");
  if ("Duplicate"             in e) throw new Error(`Duplicate of ${e.Duplicate.duplicate_of.toString()}`);
  if ("GenericError"          in e) throw new Error(`${e.GenericError.error_code.toString()}: ${e.GenericError.message}`);
  throw new Error("Unauthorized / TemporarilyUnavailable");
}
