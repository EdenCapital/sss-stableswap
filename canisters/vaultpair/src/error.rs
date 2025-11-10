use candid::CandidType;
use serde::{Deserialize, Serialize};
use core::fmt;

#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub enum Error {
    InvalidInput,
    InsufficientLiquidity,
    BalanceTooLow,
    SlippageExceeded,
    PriceImpactTooHigh,
    DInvariantBroken,
    Internal(String),
}
pub type Result<T> = core::result::Result<T, Error>;

// 把 &str / String 统一映射到 Internal(String)
impl From<&'static str> for Error {
    fn from(s: &'static str) -> Self { Error::Internal(s.to_string()) }
}
impl From<String> for Error {
    fn from(s: String) -> Self { Error::Internal(s) }
}

// 可选：便于日志输出
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Internal(m) => write!(f, "Internal({})", m),
            other => write!(f, "{:?}", other),
        }
    }
}
