import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export interface Account {
  'owner' : Principal,
  'subaccount' : [] | [Uint8Array | number[]],
}
export type AmountE6 = bigint;
export interface Available { 'usdc' : bigint, 'usdt' : bigint }
export interface CyclesInfo {
  'low' : boolean,
  'balance' : bigint,
  'alert_threshold' : bigint,
}
export interface DepositTarget {
  'sub' : Uint8Array | number[],
  'owner' : Principal,
  'ai_hex' : string,
}
export type Event = {
    'Withdraw' : {
      'ts' : bigint,
      'who' : string,
      'token' : TokenId,
      'amount' : AmountE6,
    }
  } |
  {
    'Deposit' : {
      'ts' : bigint,
      'who' : string,
      'token' : TokenId,
      'amount' : AmountE6,
    }
  } |
  {
    'Swap' : {
      'ts' : bigint,
      'who' : string,
      'dx_e6' : AmountE6,
      'dy_e6' : AmountE6,
    }
  } |
  {
    'RemoveLiq' : {
      'ts' : bigint,
      'who' : string,
      'shares' : AmountE6,
      'usdc' : AmountE6,
      'usdt' : AmountE6,
    }
  } |
  {
    'AddLiq' : {
      'ts' : bigint,
      'who' : string,
      'shares' : AmountE6,
      'usdc' : AmountE6,
      'usdt' : AmountE6,
    }
  };
export interface HourBucket {
  /**
   * (dx+dy)/2
   */
  'fee_e6' : bigint,
  /**
   * 小时整点（秒 / 3600）
   */
  'volume_e6' : bigint,
  /**
   * 输入侧手续费
   */
  'swaps' : number,
  'ts_hour' : bigint,
}
export interface PoolInfo {
  'a_amp' : number,
  'virtual_price_e6' : bigint,
  'fee_bps' : number,
  'total_shares' : AmountE6,
  'reserve_usdc' : AmountE6,
  'reserve_usdt' : AmountE6,
}
export interface PoolReserves { 'usdc' : bigint, 'usdt' : bigint }
export interface Position { 'shares' : AmountE6 }
export interface QuoteOut {
  'fee_e6' : AmountE6,
  'price_e6' : bigint,
  'dy_e6' : AmountE6,
}
export interface RiskParams {
  'd_tolerance_e6' : bigint,
  'max_price_impact_bps' : number,
}
export interface StatsSnapshot {
  'now_sec' : bigint,
  'fee_24h_e6' : bigint,
  'swaps_24h' : number,
  'vol_7d_e6' : bigint,
  'tvl_e6' : bigint,
  'apy_24h_bp' : number,
  'vol_24h_e6' : bigint,
  'fee_7d_e6' : bigint,
}
export interface SubBalance {
  'id' : string,
  'bob' : AmountE6,
  'icp' : AmountE6,
  'usdc' : AmountE6,
  'usdt' : AmountE6,
}
export interface SwapArgs {
  'min_dy_e6' : AmountE6,
  'token_in' : TokenId,
  'account' : Account,
  'token_out' : TokenId,
  'dx_e6' : AmountE6,
}
export type TextResult = { 'ok' : string } |
  { 'err' : string };
export type TokenId = { 'BOB' : null } |
  { 'ICP' : null } |
  { 'USDC' : null } |
  { 'USDT' : null };
export interface TokenMeta {
  'dec_usdc' : number,
  'dec_usdt' : number,
  'ckusdc' : Principal,
  'ckusdt' : Principal,
}
export interface TwoAmounts { 'usdc' : bigint, 'usdt' : bigint }
export type TxResult = { 'ok' : bigint } |
  { 'err' : string };
export interface _SERVICE {
  '__get_candid_interface_tmp_hack' : ActorMethod<[], string>,
  /**
   * Positions
   */
  'add_liquidity' : ActorMethod<
    [Account, AmountE6, AmountE6],
    { 'ok' : { 'shares' : AmountE6 } } |
      { 'err' : string }
  >,
  'admin_reconcile_from_internal' : ActorMethod<[], TextResult>,
  'admin_reconcile_pool_from_live' : ActorMethod<[], TextResult>,
  'claim_fee' : ActorMethod<
    [Account],
    { 'ok' : { 'usdc' : AmountE6, 'usdt' : AmountE6 } } |
      { 'err' : string }
  >,
  'ensure_allowance_for_user' : ActorMethod<[Principal, bigint], boolean>,
  'get_available_balances' : ActorMethod<[Account], Available>,
  'get_available_balances_live_for' : ActorMethod<[Principal], Available>,
  /**
   * ===== ICRC 辅助：canister principal / 用户子账户 =====
   */
  'get_canister_principal' : ActorMethod<[], Principal>,
  'get_cycles_info' : ActorMethod<[], CyclesInfo>,
  /**
   * / 计算“指定用户 principal”的存款目标（owner=本 canister、sub=该用户派生子账户、ai_hex=ICP AccountIdentifier 16进制）
   */
  'get_deposit_target_for' : ActorMethod<[Principal], DepositTarget>,
  /**
   * Activity
   */
  'get_events' : ActorMethod<[bigint, bigint], Array<Event>>,
  'get_events_latest' : ActorMethod<[bigint], Array<Event>>,
  'get_my_available_balances_live' : ActorMethod<[], Available>,
  'get_my_deposit_target' : ActorMethod<[], DepositTarget>,
  'get_my_icp_account_id_hex' : ActorMethod<[], string>,
  'get_my_subaccount' : ActorMethod<[], Uint8Array | number[]>,
  'get_pool_account' : ActorMethod<[string], Account>,
  /**
   * Explore
   */
  'get_pool_info' : ActorMethod<[], PoolInfo>,
  'get_pool_reserves_live' : ActorMethod<[], PoolReserves>,
  'get_risk_params' : ActorMethod<[], RiskParams>,
  'get_stats_series' : ActorMethod<[number], Array<HourBucket>>,
  'get_stats_snapshot' : ActorMethod<[], StatsSnapshot>,
  'get_token_meta' : ActorMethod<[], [] | [TokenMeta]>,
  /**
   * ===== 权威统计 / 风控 / Cycles =====
   */
  'get_tvl_e6' : ActorMethod<[], bigint>,
  'get_unclaimed_fee' : ActorMethod<
    [Account],
    { 'usdc' : AmountE6, 'usdt' : AmountE6 }
  >,
  /**
   * Assets（主/子账户 + 演示划转）
   */
  'get_user_balances' : ActorMethod<
    [Account],
    { 'bob' : AmountE6, 'icp' : AmountE6, 'usdc' : AmountE6, 'usdt' : AmountE6 }
  >,
  'get_user_position' : ActorMethod<[Account], Position>,
  'get_user_sub_balances' : ActorMethod<[Account], Array<SubBalance>>,
  /**
   * Swap
   */
  'quote' : ActorMethod<[TokenId, TokenId, AmountE6], QuoteOut>,
  'quote_exact_out' : ActorMethod<[TokenId, TokenId, AmountE6], QuoteOut>,
  'quote_live' : ActorMethod<[TokenId, TokenId, AmountE6], QuoteOut>,
  'quote_live_exact_out' : ActorMethod<[TokenId, TokenId, AmountE6], QuoteOut>,
  'refresh_available_for' : ActorMethod<
    [Principal],
    { 'ok' : string } |
      { 'err' : string }
  >,
  'remove_liquidity' : ActorMethod<
    [Account, AmountE6],
    { 'ok' : { 'usdc' : AmountE6, 'usdt' : AmountE6 } } |
      { 'err' : string }
  >,
  'set_token_meta' : ActorMethod<[TokenMeta], undefined>,
  'swap' : ActorMethod<
    [SwapArgs],
    { 'ok' : { 'dy_e6' : AmountE6 } } |
      { 'err' : string }
  >,
  'swap_live' : ActorMethod<
    [SwapArgs],
    { 'ok' : { 'dy_e6' : AmountE6 } } |
      { 'err' : string }
  >,
  'transfer_from_pool_to_user_sub' : ActorMethod<
    [string, Principal, bigint],
    { 'ok' : bigint } |
      { 'err' : string }
  >,
  'transfer_from_user_sub_to_pool' : ActorMethod<
    [string, Principal, bigint],
    { 'ok' : bigint } |
      { 'err' : string }
  >,
  'withdraw_from_sub' : ActorMethod<
    [string, Account, bigint],
    { 'ok' : string } |
      { 'err' : string }
  >,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
