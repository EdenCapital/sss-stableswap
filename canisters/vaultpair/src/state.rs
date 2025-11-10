// canisters/vaultpair/src/state.rs
use candid::{CandidType, Principal};
use serde::{Serialize,Deserialize};
use std::{cell::RefCell, collections::BTreeMap};
use crate::events::{Event,MAX_EVENTS};
use crate::stats::RollingStats;
use crate::types::RiskParams;
use crate::ledger_book::LedgerBook;


pub const DEFAULT_SUB_ID:&str = "main";            // 统一子账户ID
pub fn skey(owner: &Principal) -> String {
    format!("{}#{}", owner.to_text(), DEFAULT_SUB_ID)
}

#[derive(CandidType,Serialize,Deserialize,Clone,Debug)]
pub struct Pool{
  pub a_amp:u32,
  pub fee_bps:u16,
  pub reserve_usdc:u128,
  pub reserve_usdt:u128,
  pub total_shares:u128,
  pub virtual_price_e6:u128,
}

#[derive(CandidType,Serialize,Deserialize,Clone,Debug,Default)]
pub struct State{
  pub pool:Pool,
  pub events:Vec<Event>,

  // === 统计与风控 ===
  pub stats: RollingStats,
  pub risk: RiskParams,
  pub cycles_alert_threshold: u128,  
  pub ledger_book: LedgerBook,
  

  // 主账户余额（key = Principal text）
  pub user_usdc:BTreeMap<String,u128>,
  pub user_usdt:BTreeMap<String,u128>,
  pub user_bob :BTreeMap<String,u128>,
  pub user_icp :BTreeMap<String,u128>,

  // 子账户余额（key = "owner#subId"，本期仅用 main）
  pub user_sub_usdc:BTreeMap<String,u128>,
  pub user_sub_usdt:BTreeMap<String,u128>,
  pub user_sub_bob :BTreeMap<String,u128>,
  pub user_sub_icp :BTreeMap<String,u128>,

  // LP 份额
  pub user_shares:BTreeMap<String,u128>,

  // ===== 手续费累计（新增） =====
  // fee 暂存金库（swap 时累加到这里；不计入池子储备）
  pub fee_vault_usdc:u128,
  pub fee_vault_usdt:u128,
  // 全局每份额累计（放大 1e18，避免精度损失）
  pub fee_growth_usdc_e18:u128,
  pub fee_growth_usdt_e18:u128,
  // 用户上次记录的全局索引
  pub user_fee_idx_usdc:BTreeMap<String,u128>,
  pub user_fee_idx_usdt:BTreeMap<String,u128>,
  // 用户累计未领取
  pub user_fee_owed_usdc:BTreeMap<String,u128>,
  pub user_fee_owed_usdt:BTreeMap<String,u128>,

  // 演示：首次查询主账户时自动空投
  pub demo_airdrop_enabled:bool,

  // 代币元信息（主网固化；Option 以兼容旧状态）
  pub ckusdc: Option<candid::Principal>,
  pub ckusdt: Option<candid::Principal>,
  pub dec_usdc: Option<u8>,
  pub dec_usdt: Option<u8>,

}

impl Default for Pool{
  fn default()->Self{
    Self{
      a_amp:100,
      fee_bps:10,
      reserve_usdc:0,
      reserve_usdt:0,
      total_shares:0,
      virtual_price_e6:1_000_000,
    }
  }
}

thread_local!{
  pub static STATE:RefCell<State>=RefCell::new(State{
    pool:Pool::default(),
    events:Vec::new(),

    stats: RollingStats::with_now(now()),
    risk: RiskParams { max_price_impact_bps: 3000, d_tolerance_e6: 50 },
    cycles_alert_threshold: 50_000_000_000_000u128, // 示例阈值
    ledger_book: LedgerBook::default(),    
        
    user_usdc:BTreeMap::new(),
    user_usdt:BTreeMap::new(),
    user_bob:BTreeMap::new(),
    user_icp:BTreeMap::new(),
    user_sub_usdc:BTreeMap::new(),
    user_sub_usdt:BTreeMap::new(),
    user_sub_bob :BTreeMap::new(),
    user_sub_icp :BTreeMap::new(),
    user_shares:BTreeMap::new(),

    // 新增字段初始化
    fee_vault_usdc:0,
    fee_vault_usdt:0,
    fee_growth_usdc_e18:0,
    fee_growth_usdt_e18:0,
    user_fee_idx_usdc:BTreeMap::new(),
    user_fee_idx_usdt:BTreeMap::new(),
    user_fee_owed_usdc:BTreeMap::new(),
    user_fee_owed_usdt:BTreeMap::new(),

    demo_airdrop_enabled:false,

    ckusdc: None,
    ckusdt: None,
    dec_usdc: None,
    dec_usdt: None,

  });
}

pub fn push_event(ev:Event){
  STATE.with(|s|{
    let mut s=s.borrow_mut();
    s.events.push(ev);
    if s.events.len()>MAX_EVENTS { let over=s.events.len()-MAX_EVENTS; s.events.drain(0..over); }
  });
}

// 用 ic_cdk::api::time() 防止 wasm panic
pub fn now()->u64{ (ic_cdk::api::time()/1_000_000_000) as u64 }
// 纳秒（给 ledger_book 用）
pub fn now_ns() -> u64 { ic_cdk::api::time() }

#[ic_cdk::pre_upgrade]
fn pre_upgrade(){
  STATE.with(|s| ic_cdk::storage::stable_save((s.borrow().clone(),)).expect("stable_save"));
}

#[ic_cdk::post_upgrade]
fn post_upgrade(){
  if let Ok((loaded,))=ic_cdk::storage::stable_restore::<(State,)>(){ STATE.with(|s| *s.borrow_mut()=loaded ); }
}

