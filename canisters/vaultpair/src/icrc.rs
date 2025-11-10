// canisters/vaultpair/src/icrc.rs
use candid::{CandidType, Deserialize, Nat, Principal};
use ic_cdk::api::call::call as ic_call;

use crate::types::Account;
use ic_cdk::api;



/// 固定的池子子账户：字节为 "POOL" + 28 个 0，共 32 字节
pub const POOL_SUBACCOUNT: [u8; 32] = [
    0x50, 0x4F, 0x4F, 0x4C, // 'P''O''O''L'
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
];

/// 返回池子的 ICRC 账户（owner = 本 canister，sub = 固定 POOL_SUBACCOUNT）
pub fn pool_account() -> Account {
    Account {
        owner: api::id(),
        subaccount: Some(POOL_SUBACCOUNT.to_vec()),
    }
}

/* ============ v1 子账户派生（稳定算法） ============ */
const VERSION_TAG_V1: [u8; 4] = *b"SSS1";
const SALT_V1: &[u8] = b"sss#sub:v1|";

pub fn canister_principal() -> Principal {
    ic_cdk::api::id()
}

pub fn derive_subaccount(user: Principal) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let can = canister_principal();

    let mut h = Sha256::new();
    h.update(SALT_V1);
    h.update(can.as_slice());
    h.update(user.as_slice());
    let digest = h.finalize(); // 32B

    let mut sub = [0u8; 32];
    sub[0..4].copy_from_slice(&VERSION_TAG_V1); // "SSS1"
    sub[4..32].copy_from_slice(&digest[..28]);  // 取前28B
    sub
}

/* ============ ICRC-1 交互 ============ */

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Icrc1TransferArg {
    pub from_subaccount: Option<serde_bytes::ByteBuf>,
    pub to: Account,
    pub amount: Nat,
    pub fee: Option<Nat>,
    pub memo: Option<serde_bytes::ByteBuf>,
    pub created_at_time: Option<u64>,
}

#[derive(CandidType, Deserialize, Debug)]
pub enum TransferError {
    BadFee { expected_fee: Nat },
    BadBurn { min_burn_amount: Nat },
    InsufficientFunds { balance: Nat },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    TemporarilyUnavailable,
    Duplicate { duplicate_of: Nat },
    GenericError { error_code: Nat, message: String },
}

/// 正确按 ICRC-1 规范解码：返回 Ok(Nat) 或 Err(TransferError)
pub async fn icrc1_transfer(token: Principal, arg: Icrc1TransferArg) -> Result<Nat, String> {
    let (res,): (Result<Nat, TransferError>,) = ic_call(token, "icrc1_transfer", (arg,))
        .await
        .map_err(|e| format!("icrc1_transfer call failed: {:?}", e))?;
    res.map_err(|e| format!("transfer error: {:?}", e))
}

/// 从【调用者派生子账户】转出到任意目标
pub async fn transfer_from_user_sub(
    token: Principal,
    caller: Principal,
    to: Account,
    amount: Nat,
) -> Result<Nat, String> {
    let sub = derive_subaccount(caller);
    let arg = Icrc1TransferArg {
        from_subaccount: Some(serde_bytes::ByteBuf::from(sub.to_vec())),
        to,
        amount,
        fee: None,              // 用 token 默认 fee
        memo: None,
        created_at_time: None,  // 避免 TooOld
    };
    icrc1_transfer(token, arg).await
}

/* ============ ICP Account Identifier（fd1e…）工具 ============ */
pub fn icp_account_identifier(owner: Principal, sub: [u8; 32]) -> [u8; 32] {
    use sha2::{Digest, Sha224};
    use crc32fast::Hasher as Crc32;

    // hash = sha224( 0x0A || "account-id" || owner || sub )
    let mut sha = Sha224::new();
    sha.update(&[0x0A]);
    sha.update(b"account-id");
    sha.update(owner.as_slice());
    sha.update(&sub);
    let hash = sha.finalize(); // 28B

    // AI = CRC32(hash) || hash
    let mut c = Crc32::new();
    c.update(&hash);
    let crc = c.finalize().to_be_bytes();

    let mut out = [0u8; 32];
    out[0..4].copy_from_slice(&crc);
    out[4..32].copy_from_slice(&hash);
    out
}

pub fn to_hex32(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        use core::fmt::Write;
        write!(&mut s, "{:02x}", b).unwrap();
    }
    s
}

/// 查询 ICRC-1 余额：返回 Ok(Nat) 或 Err(String)
pub async fn icrc1_balance_of(token: Principal, acct: Account) -> Result<Nat, String> {
    let (bal,): (Nat,) = ic_call(token, "icrc1_balance_of", (acct,))
        .await
        .map_err(|e| format!("icrc1_balance_of call failed: {:?}", e))?;
    Ok(bal)
}