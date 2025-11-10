export const idlFactory = ({ IDL }) => {
  const Account = IDL.Record({
    'owner' : IDL.Principal,
    'subaccount' : IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const AmountE6 = IDL.Nat;
  const TextResult = IDL.Variant({ 'ok' : IDL.Text, 'err' : IDL.Text });
  const Available = IDL.Record({ 'usdc' : IDL.Nat, 'usdt' : IDL.Nat });
  const CyclesInfo = IDL.Record({
    'low' : IDL.Bool,
    'balance' : IDL.Nat,
    'alert_threshold' : IDL.Nat,
  });
  const DepositTarget = IDL.Record({
    'sub' : IDL.Vec(IDL.Nat8),
    'owner' : IDL.Principal,
    'ai_hex' : IDL.Text,
  });
  const TokenId = IDL.Variant({
    'BOB' : IDL.Null,
    'ICP' : IDL.Null,
    'USDC' : IDL.Null,
    'USDT' : IDL.Null,
  });
  const Event = IDL.Variant({
    'Withdraw' : IDL.Record({
      'ts' : IDL.Nat64,
      'who' : IDL.Text,
      'token' : TokenId,
      'amount' : AmountE6,
    }),
    'Deposit' : IDL.Record({
      'ts' : IDL.Nat64,
      'who' : IDL.Text,
      'token' : TokenId,
      'amount' : AmountE6,
    }),
    'Swap' : IDL.Record({
      'ts' : IDL.Nat64,
      'who' : IDL.Text,
      'dx_e6' : AmountE6,
      'dy_e6' : AmountE6,
    }),
    'RemoveLiq' : IDL.Record({
      'ts' : IDL.Nat64,
      'who' : IDL.Text,
      'shares' : AmountE6,
      'usdc' : AmountE6,
      'usdt' : AmountE6,
    }),
    'AddLiq' : IDL.Record({
      'ts' : IDL.Nat64,
      'who' : IDL.Text,
      'shares' : AmountE6,
      'usdc' : AmountE6,
      'usdt' : AmountE6,
    }),
  });
  const PoolInfo = IDL.Record({
    'a_amp' : IDL.Nat32,
    'virtual_price_e6' : IDL.Nat,
    'fee_bps' : IDL.Nat16,
    'total_shares' : AmountE6,
    'reserve_usdc' : AmountE6,
    'reserve_usdt' : AmountE6,
  });
  const PoolReserves = IDL.Record({ 'usdc' : IDL.Nat, 'usdt' : IDL.Nat });
  const RiskParams = IDL.Record({
    'd_tolerance_e6' : IDL.Nat64,
    'max_price_impact_bps' : IDL.Nat32,
  });
  const HourBucket = IDL.Record({
    'fee_e6' : IDL.Nat,
    'volume_e6' : IDL.Nat,
    'swaps' : IDL.Nat32,
    'ts_hour' : IDL.Nat64,
  });
  const StatsSnapshot = IDL.Record({
    'now_sec' : IDL.Nat64,
    'fee_24h_e6' : IDL.Nat,
    'swaps_24h' : IDL.Nat32,
    'vol_7d_e6' : IDL.Nat,
    'tvl_e6' : IDL.Nat,
    'apy_24h_bp' : IDL.Nat32,
    'vol_24h_e6' : IDL.Nat,
    'fee_7d_e6' : IDL.Nat,
  });
  const TokenMeta = IDL.Record({
    'dec_usdc' : IDL.Nat8,
    'dec_usdt' : IDL.Nat8,
    'ckusdc' : IDL.Principal,
    'ckusdt' : IDL.Principal,
  });
  const Position = IDL.Record({ 'shares' : AmountE6 });
  const SubBalance = IDL.Record({
    'id' : IDL.Text,
    'bob' : AmountE6,
    'icp' : AmountE6,
    'usdc' : AmountE6,
    'usdt' : AmountE6,
  });
  const QuoteOut = IDL.Record({
    'fee_e6' : AmountE6,
    'price_e6' : IDL.Nat,
    'dy_e6' : AmountE6,
  });
  const SwapArgs = IDL.Record({
    'min_dy_e6' : AmountE6,
    'token_in' : TokenId,
    'account' : Account,
    'token_out' : TokenId,
    'dx_e6' : AmountE6,
  });
  return IDL.Service({
    '__get_candid_interface_tmp_hack' : IDL.Func([], [IDL.Text], ['query']),
    'add_liquidity' : IDL.Func(
        [Account, AmountE6, AmountE6],
        [
          IDL.Variant({
            'ok' : IDL.Record({ 'shares' : AmountE6 }),
            'err' : IDL.Text,
          }),
        ],
        [],
      ),
    'admin_reconcile_from_internal' : IDL.Func([], [TextResult], []),
    'admin_reconcile_pool_from_live' : IDL.Func([], [TextResult], []),
    'claim_fee' : IDL.Func(
        [Account],
        [
          IDL.Variant({
            'ok' : IDL.Record({ 'usdc' : AmountE6, 'usdt' : AmountE6 }),
            'err' : IDL.Text,
          }),
        ],
        [],
      ),
    'ensure_allowance_for_user' : IDL.Func(
        [IDL.Principal, IDL.Nat],
        [IDL.Bool],
        [],
      ),
    'get_available_balances' : IDL.Func([Account], [Available], ['query']),
    'get_available_balances_live_for' : IDL.Func(
        [IDL.Principal],
        [Available],
        ['query'],
      ),
    'get_canister_principal' : IDL.Func([], [IDL.Principal], ['query']),
    'get_cycles_info' : IDL.Func([], [CyclesInfo], ['query']),
    'get_deposit_target_for' : IDL.Func(
        [IDL.Principal],
        [DepositTarget],
        ['query'],
      ),
    'get_events' : IDL.Func([IDL.Nat, IDL.Nat], [IDL.Vec(Event)], ['query']),
    'get_events_latest' : IDL.Func([IDL.Nat], [IDL.Vec(Event)], ['query']),
    'get_my_available_balances_live' : IDL.Func([], [Available], ['query']),
    'get_my_deposit_target' : IDL.Func([], [DepositTarget], ['query']),
    'get_my_icp_account_id_hex' : IDL.Func([], [IDL.Text], ['query']),
    'get_my_subaccount' : IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),
    'get_pool_account' : IDL.Func([IDL.Text], [Account], ['query']),
    'get_pool_info' : IDL.Func([], [PoolInfo], ['query']),
    'get_pool_reserves_live' : IDL.Func([], [PoolReserves], ['query']),
    'get_risk_params' : IDL.Func([], [RiskParams], ['query']),
    'get_stats_series' : IDL.Func(
        [IDL.Nat32],
        [IDL.Vec(HourBucket)],
        ['query'],
      ),
    'get_stats_snapshot' : IDL.Func([], [StatsSnapshot], ['query']),
    'get_token_meta' : IDL.Func([], [IDL.Opt(TokenMeta)], ['query']),
    'get_tvl_e6' : IDL.Func([], [IDL.Nat], ['query']),
    'get_unclaimed_fee' : IDL.Func(
        [Account],
        [IDL.Record({ 'usdc' : AmountE6, 'usdt' : AmountE6 })],
        ['query'],
      ),
    'get_user_balances' : IDL.Func(
        [Account],
        [
          IDL.Record({
            'bob' : AmountE6,
            'icp' : AmountE6,
            'usdc' : AmountE6,
            'usdt' : AmountE6,
          }),
        ],
        ['query'],
      ),
    'get_user_position' : IDL.Func([Account], [Position], ['query']),
    'get_user_sub_balances' : IDL.Func(
        [Account],
        [IDL.Vec(SubBalance)],
        ['query'],
      ),
    'quote' : IDL.Func([TokenId, TokenId, AmountE6], [QuoteOut], ['query']),
    'quote_exact_out' : IDL.Func(
        [TokenId, TokenId, AmountE6],
        [QuoteOut],
        ['query'],
      ),
    'quote_live' : IDL.Func(
        [TokenId, TokenId, AmountE6],
        [QuoteOut],
        ['query'],
      ),
    'quote_live_exact_out' : IDL.Func(
        [TokenId, TokenId, AmountE6],
        [QuoteOut],
        ['query'],
      ),
    'refresh_available_for' : IDL.Func(
        [IDL.Principal],
        [IDL.Variant({ 'ok' : IDL.Text, 'err' : IDL.Text })],
        [],
      ),
    'remove_liquidity' : IDL.Func(
        [Account, AmountE6],
        [
          IDL.Variant({
            'ok' : IDL.Record({ 'usdc' : AmountE6, 'usdt' : AmountE6 }),
            'err' : IDL.Text,
          }),
        ],
        [],
      ),
    'set_token_meta' : IDL.Func([TokenMeta], [], []),
    'swap' : IDL.Func(
        [SwapArgs],
        [
          IDL.Variant({
            'ok' : IDL.Record({ 'dy_e6' : AmountE6 }),
            'err' : IDL.Text,
          }),
        ],
        [],
      ),
    'swap_live' : IDL.Func(
        [SwapArgs],
        [
          IDL.Variant({
            'ok' : IDL.Record({ 'dy_e6' : AmountE6 }),
            'err' : IDL.Text,
          }),
        ],
        [],
      ),
    'transfer_from_pool_to_user_sub' : IDL.Func(
        [IDL.Text, IDL.Principal, IDL.Nat],
        [IDL.Variant({ 'ok' : IDL.Nat, 'err' : IDL.Text })],
        [],
      ),
    'transfer_from_user_sub_to_pool' : IDL.Func(
        [IDL.Text, IDL.Principal, IDL.Nat],
        [IDL.Variant({ 'ok' : IDL.Nat, 'err' : IDL.Text })],
        [],
      ),
    'withdraw_from_sub' : IDL.Func(
        [IDL.Text, Account, IDL.Nat],
        [IDL.Variant({ 'ok' : IDL.Text, 'err' : IDL.Text })],
        [],
      ),
  });
};
export const init = ({ IDL }) => { return []; };
