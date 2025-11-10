#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/9] 目录结构"
mkdir -p canisters/vaultpair/src
mkdir -p canisters/www/src/{app,api,components,pages/Swap,pages/Liquidity,pages/Explore}
mkdir -p scripts

echo "[2/9] .gitignore"
cat > .gitignore <<'GIT'
/.dfx/
/target/
/node_modules/
/canisters/vaultpair/target/
dist/
*.wasm
.DS_Store
GIT

echo "[3/9] dfx.json"
cat > dfx.json <<'JSON'
{
  "version": 1,
  "dfx": "0.29.2",
  "canisters": {
    "vaultpair": {
      "type": "custom",
      "candid": "canisters/vaultpair/src/vaultpair.did",
      "build": "cargo build --manifest-path canisters/vaultpair/Cargo.toml --release --target wasm32-unknown-unknown",
      "wasm": "canisters/vaultpair/target/wasm32-unknown-unknown/release/vaultpair.wasm",
      "metadata": [{ "name": "candid:service" }]
    },
    "www": {
      "type": "assets",
      "source": ["canisters/www/dist"],
      "build": "npm --prefix canisters/www ci && dfx generate vaultpair && node scripts/copy-did.mjs && npm --prefix canisters/www run build"
    }
  },
  "networks": { "local": { "bind": "127.0.0.1:4943", "type": "ephemeral" } }
}
JSON

echo "[4/9] Cargo.toml"
cat > canisters/vaultpair/Cargo.toml <<'TOML'
[package]
name = "vaultpair"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
candid = "0.10"
ic-cdk = "0.14"
serde = { version = "1.0", features = ["derive"] }
serde_bytes = "0.11"
TOML

echo "[5/9] vaultpair.did（占位）"
cat > canisters/vaultpair/src/vaultpair.did <<'DID'
type AmountE6 = nat;
type Account = record { owner: principal; subaccount: opt vec nat8 };
type TokenId = variant { USDC; USDT; ICP };
type PoolInfo = record { a_amp: nat32; fee_bps: nat16; reserve_usdc: AmountE6; reserve_usdt: AmountE6; total_shares: AmountE6; virtual_price_e6: nat };
type QuoteOut = record { dy_e6: AmountE6; fee_e6: AmountE6; price_e6: nat };
type SwapArgs = record { account: Account; token_in: TokenId; token_out: TokenId; dx_e6: AmountE6; min_dy_e6: AmountE6 };
type Event = variant {
  Swap: record { who: text; dx_e6: AmountE6; dy_e6: AmountE6; ts: nat64 };
  AddLiq: record { who: text; usdc: AmountE6; usdt: AmountE6; shares: AmountE6; ts: nat64 };
  RemoveLiq: record { who: text; shares: AmountE6; usdc: AmountE6; usdt: AmountE6; ts: nat64 };
  Deposit: record { who: text; token: TokenId; amount: AmountE6; ts: nat64 };
  Withdraw: record { who: text; token: TokenId; amount: AmountE6; ts: nat64 };
};
type Result<T> = variant { ok: T; err: text };
service : {
  get_pool_info : () -> (PoolInfo) query;
  quote : (TokenId, TokenId, AmountE6) -> (QuoteOut) query;
  swap  : (SwapArgs) -> (Result record { dy_e6: AmountE6 });
  add_liquidity    : (Account, AmountE6, AmountE6) -> (Result record { shares: AmountE6 });
  remove_liquidity : (Account, AmountE6) -> (Result record { usdc: AmountE6; usdt: AmountE6 });
  get_user_balances : (Account) -> (record { usdc: AmountE6; usdt: AmountE6 }) query;
  deposit_demo      : (Account, TokenId, AmountE6) -> (Result text);
  withdraw_demo     : (Account, TokenId, AmountE6) -> (Result text);
  get_events : (nat, nat) -> (vec Event) query;
  __get_candid_interface_tmp_hack : () -> (text) query;
}
DID

echo "[6/9] Rust 模块骨架"
cat > canisters/vaultpair/src/lib.rs <<'RS'
mod types; mod error; mod events; mod state; mod icrc;
mod swap; mod positions; mod assets; mod explore; mod activity; mod api;
pub use api::*;
#[ic_cdk::query(name="__get_candid_interface_tmp_hack")]
fn export_candid()->String{ use ic_cdk::export::candid::export_service; export_service!(); __export_service() }
RS

cat > canisters/vaultpair/src/types.rs <<'RS'
use candid::{CandidType, Principal}; use serde::{Deserialize,Serialize};
pub type AmountE6=u128;
#[derive(CandidType,Serialize,Deserialize,Clone,Debug)] pub enum TokenId{USDC,USDT,ICP}
#[derive(CandidType,Serialize,Deserialize,Clone,Debug)] pub struct Account{pub owner:Principal,pub subaccount:Option<Vec<u8>>}
#[derive(CandidType,Serialize,Deserialize,Clone,Debug,Default)] pub struct PoolInfo{pub a_amp:u32,pub fee_bps:u16,pub reserve_usdc:AmountE6,pub reserve_usdt:AmountE6,pub total_shares:AmountE6,pub virtual_price_e6:u128}
#[derive(CandidType,Serialize,Deserialize,Clone,Debug,Default)] pub struct QuoteOut{pub dy_e6:AmountE6,pub fee_e6:AmountE6,pub price_e6:u128}
#[derive(CandidType,Serialize,Deserialize,Clone,Debug)] pub struct SwapArgs{pub account:Account,pub token_in:TokenId,pub token_out:TokenId,pub dx_e6:AmountE6,pub min_dy_e6:AmountE6}
RS

cat > canisters/vaultpair/src/error.rs <<'RS'
use candid::CandidType; use serde::{Deserialize,Serialize};
#[derive(CandidType,Serialize,Deserialize,Debug)] pub enum Error{InvalidInput,InsufficientLiquidity,BalanceTooLow,SlippageExceeded,Internal(String)}
pub type Result<T>=std::result::Result<T,Error>;
RS

cat > canisters/vaultpair/src/events.rs <<'RS'
use crate::types::{AmountE6,TokenId}; use candid::CandidType; use serde::{Deserialize,Serialize};
#[derive(CandidType,Serialize,Deserialize,Clone,Debug)]
pub enum Event{Swap{who:String,dx_e6:AmountE6,dy_e6:AmountE6,ts:u64},AddLiq{who:String,usdc:AmountE6,usdt:AmountE6,shares:AmountE6,ts:u64},RemoveLiq{who:String,shares:AmountE6,usdc:AmountE6,usdt:AmountE6,ts:u64},Deposit{who:String,token:TokenId,amount:AmountE6,ts:u64},Withdraw{who:String,token:TokenId,amount:AmountE6,ts:u64}}
pub const MAX_EVENTS:usize=2000;
RS

cat > canisters/vaultpair/src/state.rs <<'RS'
use crate::{events::{Event,MAX_EVENTS},types::{AmountE6,PoolInfo}}; use ic_cdk::api::time; use serde::{Deserialize,Serialize}; use std::cell::RefCell;
#[derive(Serialize,Deserialize,Default,Clone)] pub struct State{pub pool:PoolInfo,pub user_usdc:std::collections::BTreeMap<String,AmountE6>,pub user_usdt:std::collections::BTreeMap<String,AmountE6>,pub events:Vec<Event>}
thread_local!{ pub static STATE:RefCell<State>=RefCell::new(State{pool:PoolInfo{a_amp:100,fee_bps:20,reserve_usdc:0,reserve_usdt:0,total_shares:0,virtual_price_e6:1_000_000},..Default::default()});}
pub fn now()->u64{time()}
pub fn push_event(e:Event){ STATE.with(|s|{ let mut s=s.borrow_mut(); s.events.push(e); if s.events.len()>MAX_EVENTS{ let cut=s.events.len()-MAX_EVENTS; s.events.drain(0..cut);} }); }
#[ic_cdk::pre_upgrade] fn pre_upgrade(){ STATE.with(|s| ic_cdk::storage::stable_save((s.borrow().clone(),)).expect("stable_save")); }
#[ic_cdk::post_upgrade] fn post_upgrade(){ if let Ok((loaded,))=ic_cdk::storage::stable_restore::<(State,)>(){ STATE.with(|s| *s.borrow_mut()=loaded ); } }
RS

cat > canisters/vaultpair/src/icrc.rs <<'RS'
pub struct IcrcLedger; impl IcrcLedger{ #[allow(dead_code)] pub async fn transfer(_to:String,_amount_e6:u128)->Result<String,String>{Err("not implemented".into())}}
RS

cat > canisters/vaultpair/src/swap/mod.rs <<'RS'
use crate::{types::{TokenId,AmountE6,QuoteOut,SwapArgs},state::{STATE,now,push_event},events::Event,error::{Result,Error}};
fn fee_of(dx:AmountE6,fee_bps:u16)->AmountE6{ dx*(fee_bps as u128)/10_000 }
pub fn quote(token_in:TokenId,token_out:TokenId,dx_e6:AmountE6)->QuoteOut{
  let same= !matches!((token_in,token_out),(TokenId::USDC,TokenId::USDC)|(TokenId::USDT,TokenId::USDT)|(TokenId::ICP,TokenId::ICP));
  STATE.with(|s|{ let s=s.borrow(); let fee=fee_of(dx_e6,s.pool.fee_bps); QuoteOut{dy_e6: if same{dx_e6.saturating_sub(fee)}else{0}, fee_e6:fee, price_e6:1_000_000}})
}
pub fn swap(args:SwapArgs)->Result<u128>{
  if args.dx_e6==0 {return Err(Error::InvalidInput)}
  let p=args.account.owner.to_text();
  let dy=STATE.with(|s|{ let s=s.borrow(); let fee=fee_of(args.dx_e6,s.pool.fee_bps); args.dx_e6.saturating_sub(fee)});
  if dy<args.min_dy_e6 {return Err(Error::SlippageExceeded)}
  push_event(Event::Swap{who:p,dx_e6:args.dx_e6,dy_e6:dy,ts:now()}); Ok(dy)
}
RS

cat > canisters/vaultpair/src/positions/mod.rs <<'RS'
use crate::{types::{AmountE6,Account},state::{STATE,now,push_event},events::Event,error::{Result,Error}};
pub fn add_liquidity(acct:Account,usdc:AmountE6,usdt:AmountE6)->Result<AmountE6>{
  if usdc==0 && usdt==0 {return Err(Error::InvalidInput)}
  let who=acct.owner.to_text(); let shares=usdc+usdt;
  STATE.with(|s|{ let mut s=s.borrow_mut(); s.pool.total_shares+=shares; s.pool.reserve_usdc+=usdc; s.pool.reserve_usdt+=usdt; });
  push_event(Event::AddLiq{who,usdc,usdt,shares,ts:now()}); Ok(shares)
}
pub fn remove_liquidity(acct:Account,shares:AmountE6)->Result<(AmountE6,AmountE6)>{
  if shares==0 {return Err(Error::InvalidInput)} let who=acct.owner.to_text();
  let (usdc,usdt)=STATE.with(|s|{ let mut s=s.borrow_mut(); let total=s.pool.total_shares.max(1); let u=s.pool.reserve_usdc*shares/total; let v=s.pool.reserve_usdt*shares/total; s.pool.total_shares-=shares; s.pool.reserve_usdc-=u; s.pool.reserve_usdt-=v; (u,v)});
  push_event(Event::RemoveLiq{who,shares,usdc,usdt,ts:now()}); Ok((usdc,usdt))
}
RS

cat > canisters/vaultpair/src/assets/mod.rs <<'RS'
use crate::{types::{Account,AmountE6,TokenId},state::{STATE,push_event,now},error::{Result,Error},events::Event};
pub fn get_user_balances(acct:&Account)->(AmountE6,AmountE6){
  let who=acct.owner.to_text(); STATE.with(|s|{ let s=s.borrow(); (*s.user_usdc.get(&who).unwrap_or(&0), *s.user_usdt.get(&who).unwrap_or(&0)) })
}
pub fn deposit_demo(acct:Account,token:TokenId,amount:AmountE6)->Result<()>{
  if amount==0 {return Err(Error::InvalidInput)} let who=acct.owner.to_text();
  STATE.with(|s|{ let mut s=s.borrow_mut(); match token{ TokenId::USDC=>*s.user_usdc.entry(who.clone()).or_default()+=amount, TokenId::USDT=>*s.user_usdt.entry(who.clone()).or_default()+=amount, TokenId::ICP=>return Err(Error::InvalidInput),}; Ok::<(),Error>(()) })?;
  push_event(Event::Deposit{who,token,amount,ts:now()}); Ok(())
}
pub fn withdraw_demo(acct:Account,token:TokenId,amount:AmountE6)->Result<()>{
  let who=acct.owner.to_text();
  STATE.with(|s|{ let mut s=s.borrow_mut(); match token{
    TokenId::USDC=>{let b=s.user_usdc.entry(who.clone()).or_default(); if *b<amount{return Err(Error::BalanceTooLow)} *b-=amount;}
    TokenId::USDT=>{let b=s.user_usdt.entry(who.clone()).or_default(); if *b<amount{return Err(Error::BalanceTooLow)} *b-=amount;}
    TokenId::ICP=>return Err(Error::InvalidInput), }; Ok::<(),Error>(()) })?;
  push_event(Event::Withdraw{who,token,amount,ts:now()}); Ok(())
}
RS

cat > canisters/vaultpair/src/explore/mod.rs <<'RS'
use crate::types::PoolInfo; use crate::state::STATE;
pub fn get_pool_info()->PoolInfo{ STATE.with(|s| s.borrow().pool.clone()) }
RS

cat > canisters/vaultpair/src/activity/mod.rs <<'RS'
use crate::state::STATE; use crate::events::Event;
pub fn get_events(cursor:u128,limit:u128)->Vec<Event>{
  STATE.with(|s|{ let s=s.borrow(); let st=std::cmp::min(cursor as usize,s.events.len()); let en=std::cmp::min(st+(limit as usize),s.events.len()); s.events[st..en].to_vec() })
}
RS

cat > canisters/vaultpair/src/api.rs <<'RS'
use crate::{types::{TokenId,AmountE6,Account,QuoteOut,SwapArgs,PoolInfo},error::Result};
use crate::{swap,positions,assets,explore,activity};
#[ic_cdk::query] fn get_pool_info()->PoolInfo{ explore::get_pool_info() }
#[ic_cdk::query] fn quote(token_in:TokenId,token_out:TokenId,dx_e6:AmountE6)->QuoteOut{ swap::quote(token_in,token_out,dx_e6) }
#[ic_cdk::update] fn swap(args:SwapArgs)->Result<ic_cdk::export::candid::types::number::Nat>{ swap::swap(args).map(|v| v.into()) }
#[ic_cdk::update] fn add_liquidity(account:Account,usdc:AmountE6,usdt:AmountE6)->Result<ic_cdk::export::candid::types::number::Nat>{ positions::add_liquidity(account,usdc,usdt).map(|v| v.into()) }
#[ic_cdk::update] fn remove_liquidity(account:Account,shares:AmountE6)->Result<(ic_cdk::export::candid::types::number::Nat,ic_cdk::export::candid::types::number::Nat)>{ positions::remove_liquidity(account,shares).map(|(a,b)|(a.into(),b.into())) }
#[ic_cdk::query] fn get_user_balances(account:Account)->(AmountE6,AmountE6){ assets::get_user_balances(&account) }
#[ic_cdk::update] fn deposit_demo(account:Account,token:TokenId,amount:AmountE6)->Result<String>{ assets::deposit_demo(account,token,amount).map(|_|"ok".into()) }
#[ic_cdk::update] fn withdraw_demo(account:Account,token:TokenId,amount:AmountE6)->Result<String>{ assets::withdraw_demo(account,token,amount).map(|_|"ok".into()) }
#[ic_cdk::query] fn get_events(cursor:u128,limit:u128)->Vec<crate::events::Event>{ activity::get_events(cursor,limit) }
RS

echo "[7/9] 前端配置"
cat > canisters/www/package.json <<'JSON'
{
  "name": "sss05-www",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --strictPort --port 5173",
    "gen:did": "dfx generate vaultpair && node ../../scripts/copy-did.mjs"
  },
  "dependencies": {
    "@dfinity/agent": "^2.0.0",
    "@dfinity/auth-client": "^2.0.0",
    "@dfinity/principal": "^2.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.26.0",
    "@tanstack/react-query": "^5.59.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.66",
    "@types/react-dom": "^18.2.22",
    "typescript": "^5.6.0",
    "vite": "^5.2.0",
    "@vitejs/plugin-react": "^4.3.0"
  }
}
JSON

cat > canisters/www/tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022","DOM","DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "skipLibCheck": true,
    "baseUrl": "./",
    "paths": { "@api/*": ["src/api/*"], "@components/*": ["src/components/*"], "@pages/*": ["src/pages/*"], "@app/*": ["src/app/*"] }
  },
  "include": ["src"]
}
JSON

cat > canisters/www/vite.config.ts <<'TS'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins:[react()], server:{ port:5173, strictPort:true }})
TS

cat > canisters/www/index.html <<'HTML'
<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0"/><title>SSS05 • ICP StableSwap</title></head><body style="margin:0;background:#0b0b0c;color:#eaeaea"><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
HTML

echo "[8/9] 前端源文件"
cat > canisters/www/src/main.tsx <<'TS'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from './app/router'
const qc = new QueryClient()
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={qc}><RouterProvider router={router}/></QueryClientProvider>)
TS

cat > canisters/www/src/app/router.tsx <<'TS'
import React from 'react'
import { createBrowserRouter, Link, Outlet } from 'react-router-dom'
import Swap from '@pages/Swap'
import Liquidity from '@pages/Liquidity'
import Explore from '@pages/Explore'
function Shell(){ return (<div style={{padding:16}}><h2>SSS05 • StableSwap Demo</h2><nav style={{display:'flex',gap:12,marginBottom:16}}><Link to="/swap">Swap</Link><Link to="/liquidity">Liquidity</Link><Link to="/explore">Explore</Link></nav><Outlet/></div>)}
export const router=createBrowserRouter([{ path:'/', element:<Shell/>, children:[ {path:'/swap',element:<Swap/>},{path:'/liquidity',element:<Liquidity/>},{path:'/explore',element:<Explore/>} ] }])
TS

cat > canisters/www/src/api/actor.ts <<'TS'
// 创建 actor；本地会 fetchRootKey
import { HttpAgent, Actor } from '@dfinity/agent'
import { idlFactory } from '../vaultpair.did.js'
const canisterId = (import.meta as any).env?.VITE_VAULTPAIR_ID
export async function getActor(identity?: any){
  const agent = new HttpAgent({ host: 'http://127.0.0.1:4943', identity })
  // @ts-ignore
  await agent.fetchRootKey?.()
  return Actor.createActor(idlFactory, { agent, canisterId })
}
TS

cat > canisters/www/src/api/calls.ts <<'TS'
import { getActor } from './actor'
export type TokenId = { USDC?: null } | { USDT?: null } | { ICP?: null }
export type Account = { owner: string, subaccount?: number[] }
export async function get_pool_info(){ return (await getActor()).get_pool_info() }
export async function quote(token_in:TokenId,token_out:TokenId,dx_e6:bigint){ return (await getActor()).quote(token_in,token_out,dx_e6) }
export async function swap(args:{account:Account,token_in:TokenId,token_out:TokenId,dx_e6:bigint,min_dy_e6:bigint}){ return (await getActor()).swap(args) }
export async function get_user_balances(account:Account){ return (await getActor()).get_user_balances(account) }
TS

cat > canisters/www/src/components/AmountInput.tsx <<'TS'
import React from 'react'
export default function AmountInput({value,onChange}:{value:string;onChange:(v:string)=>void}){
  return <input value={value} onChange={e=>onChange(e.target.value)} placeholder="输入数量（自然数，内部 e6）" style={{padding:8,width:240}}/>
}
TS

cat > canisters/www/src/pages/Swap/index.tsx <<'TS'
import React from 'react'
import AmountInput from '@components/AmountInput'
import { quote, swap, get_user_balances, type TokenId } from '@api/calls'
const USDC:TokenId={USDC:null}; const USDT:TokenId={USDT:null}
export default function Swap(){
  const [amount,setAmount]=React.useState('100'); const [minOut,setMinOut]=React.useState('0'); const [q,setQ]=React.useState<any>(null)
  const account={ owner: 'aaaaa-aa' } // 占位
  async function doQuote(){ const dx=BigInt((Number(amount)||0)*1_000_000); setQ(await quote(USDC,USDT,dx)) }
  async function doSwap(){ const dx=BigInt((Number(amount)||0)*1_000_000); const res=await swap({account,token_in:USDC,token_out:USDT,dx_e6:dx,min_dy_e6:BigInt(minOut||'0')}); alert('swap ok: '+JSON.stringify(res)) }
  async function loadBalances(){ alert('Balances e6: '+JSON.stringify(await get_user_balances(account))) }
  return (<div><h3>/swap</h3><div style={{display:'flex',gap:12,alignItems:'center'}}><AmountInput value={amount} onChange={setAmount}/><button onClick={doQuote}>Quote</button><button onClick={doSwap}>Swap</button><button onClick={loadBalances}>My Balances</button></div><div style={{marginTop:8,fontSize:12,opacity:.8}}>{q && <>dy={String(q.dy_e6)} | fee={String(q.fee_e6)} | price_e6={String(q.price_e6)}</>}</div></div>)
}
TS

cat > canisters/www/src/pages/Liquidity/index.tsx <<'TS'
import React from 'react'
export default function Liquidity(){ return <div><h3>/liquidity</h3><p>占位：后续添加 My Positions / Add / Remove</p></div> }
TS

cat > canisters/www/src/pages/Explore/index.tsx <<'TS'
import React from 'react'
import { get_pool_info } from '@api/calls'
export default function Explore(){ const [info,setInfo]=React.useState<any>(null); React.useEffect(()=>{get_pool_info().then(setInfo)},[]); return <div><h3>/explore</h3><pre>{JSON.stringify(info,null,2)}</pre></div> }
TS

echo "[9/9] 辅助文件"
cat > scripts/copy-did.mjs <<'JS'
import { cpSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const src=resolve(".dfx/local/canisters/vaultpair/service.did.js"); const dst=resolve("canisters/www/src/vaultpair.did.js");
if(!existsSync(src)){ console.error("[copy-did] not found:",src,"\nrun `dfx generate vaultpair` or `dfx deploy` first."); process.exit(1) }
cpSync(src,dst); console.log("[copy-did] copied:",src,"→",dst)
JS

cat > canisters/www/src/vaultpair.did.d.ts <<'TS'
declare module './vaultpair.did.js' { export const idlFactory: ({ IDL }: any) => any; export const init: (...args: any[]) => any; }
TS

cat > README.md <<'MD'
# SSS05 • Skeleton
## 快速开始
```bash
cd /workspaces/SSSplus/sss05
source "$HOME/.cargo/env" || true
source "$HOME/.local/share/dfx/env" || true
export PATH="$HOME/.cargo/bin:$HOME/.local/share/dfx/bin:$PATH"
npm --prefix canisters/www ci
dfx start --background
dfx deploy
npm --prefix canisters/www run dev
