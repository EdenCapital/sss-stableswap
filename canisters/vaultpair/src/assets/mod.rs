// canisters/vaultpair/src/assets/mod.rs
use crate::{
  types::{Account,AmountE6,TokenId,SubBalance},
  state::{STATE,push_event,now,DEFAULT_SUB_ID},
  error::{Result,Error},
  events::Event
};

const AIRDROP_E6:u128 = 100_000 * 1_000_000;    // ✅ 10万（e6）

fn ensure_airdrop_if_needed(acct:&Account){
  if acct.subaccount.is_some(){ return; } // 仅主账户空投
  STATE.with(|s|{
    let mut s=s.borrow_mut();
    if !s.demo_airdrop_enabled { return; }
    let who=acct.owner.to_text();
    if s.user_usdc.get(&who).is_none(){
      s.user_usdc.insert(who.clone(), AIRDROP_E6);
      s.user_usdt.insert(who.clone(), AIRDROP_E6);
      s.user_bob .insert(who.clone(), AIRDROP_E6);
      s.user_icp .insert(who.clone(), AIRDROP_E6);
      // 子账户默认 0，无需写
    }
  });
}

pub fn get_user_balances(acct:&Account)->(AmountE6,AmountE6,AmountE6,AmountE6){
  ensure_airdrop_if_needed(acct);
  let who=acct.owner.to_text();
  STATE.with(|s|{
    let s=s.borrow();
    (
      *s.user_usdc.get(&who).unwrap_or(&0),
      *s.user_usdt.get(&who).unwrap_or(&0),
      *s.user_bob .get(&who).unwrap_or(&0),
      *s.user_icp .get(&who).unwrap_or(&0),
    )
  })
}

pub fn get_user_sub_balances(acct:&Account)->Vec<SubBalance>{
  let who = acct.owner.to_text();
  let key = format!("{}#{}", who, DEFAULT_SUB_ID);
  STATE.with(|s|{
    let s = s.borrow();
    vec![SubBalance{
      id:   DEFAULT_SUB_ID.into(),
      usdc: *s.user_sub_usdc.get(&key).unwrap_or(&0),
      usdt: *s.user_sub_usdt.get(&key).unwrap_or(&0),
      bob:  *s.user_sub_bob .get(&key).unwrap_or(&0),
      icp:  *s.user_sub_icp .get(&key).unwrap_or(&0),
    }]
  })
}



// ---------- 转入子账户（主 -> 子） ----------
pub fn deposit_demo(acct:Account,token:TokenId,amount:AmountE6)->Result<()>{
  if amount==0 {return Err(Error::InvalidInput)}
  ensure_airdrop_if_needed(&acct);
  let who=acct.owner.to_text();
  let key=format!("{}#{}", who, DEFAULT_SUB_ID);

  let res:Result<()> = STATE.with(|s|{
    let mut st=s.borrow_mut();
    let ok = match token{
      TokenId::USDC=>{
        let b=st.user_usdc.entry(who.clone()).or_default();
        if *b<amount { false } else { *b-=amount; *st.user_sub_usdc.entry(key.clone()).or_default() += amount; true }
      }
      TokenId::USDT=>{
        let b=st.user_usdt.entry(who.clone()).or_default();
        if *b<amount { false } else { *b-=amount; *st.user_sub_usdt.entry(key.clone()).or_default() += amount; true }
      }
      TokenId::BOB =>{
        let b=st.user_bob.entry(who.clone()).or_default();
        if *b<amount { false } else { *b-=amount; *st.user_sub_bob.entry(key.clone()).or_default()  += amount; true }
      }
      TokenId::ICP =>{
        let b=st.user_icp.entry(who.clone()).or_default();
        if *b<amount { false } else { *b-=amount; *st.user_sub_icp.entry(key.clone()).or_default()  += amount; true }
      }
    };
    if ok { Ok(()) } else { Err(Error::BalanceTooLow) }
  });
  res?;
  push_event(Event::Deposit{who,token,amount,ts:now()});
  Ok(())
}

// ---------- 转回主账户（子 -> 主） ----------
pub fn withdraw_demo(acct:Account,token:TokenId,amount:AmountE6)->Result<()>{
  if amount==0 {return Err(Error::InvalidInput)}
  let who=acct.owner.to_text();
  let key=format!("{}#{}", who, DEFAULT_SUB_ID);

  let res:Result<()> = STATE.with(|s|{
    let mut st=s.borrow_mut();
    let ok = match token{
      TokenId::USDC=>{
        let sb=st.user_sub_usdc.entry(key.clone()).or_default();
        if *sb<amount { false } else { *sb-=amount; *st.user_usdc.entry(who.clone()).or_default() += amount; true }
      }
      TokenId::USDT=>{
        let sb=st.user_sub_usdt.entry(key.clone()).or_default();
        if *sb<amount { false } else { *sb-=amount; *st.user_usdt.entry(who.clone()).or_default() += amount; true }
      }
      TokenId::BOB =>{
        let sb=st.user_sub_bob.entry(key.clone()).or_default();
        if *sb<amount { false } else { *sb-=amount; *st.user_bob.entry(who.clone()).or_default()  += amount; true }
      }
      TokenId::ICP =>{
        let sb=st.user_sub_icp.entry(key.clone()).or_default();
        if *sb<amount { false } else { *sb-=amount; *st.user_icp.entry(who.clone()).or_default()  += amount; true }
      }
    };
    if ok { Ok(()) } else { Err(Error::BalanceTooLow) }
  });
  res?;
  push_event(Event::Withdraw{who,token,amount,ts:now()});
  Ok(())
}
