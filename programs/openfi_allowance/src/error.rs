use anchor_lang::prelude::*;

/// Order matters: codes are 6000 + index and the TypeScript adapter maps them
/// to the shared `ChainErrorCode`s.
#[error_code]
pub enum AllowanceError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Mandate has been revoked")]
    MandateRevoked,
    #[msg("Mandate has expired")]
    MandateExpired,
    #[msg("No session key with this public key on this mandate")]
    UnknownSession,
    #[msg("Session key has been revoked")]
    SessionRevoked,
    #[msg("Session key has expired")]
    SessionExpired,
    #[msg("Intent signature missing or not from this session key")]
    BadSignature,
    #[msg("Intent was signed against an old mandate nonce")]
    StaleNonce,
    #[msg("Signed intent has expired")]
    IntentExpired,
    #[msg("Payee is not on this mandate")]
    PayeeNotAllowed,
    #[msg("Amount is above the per-pull cap")]
    PerPullCapExceeded,
    #[msg("Amount is above what remains in this epoch")]
    EpochCapExceeded,
    #[msg("Amount is above what remains for this session key in this epoch")]
    SessionCapExceeded,
    #[msg("Amount is above what remains of the mandate total")]
    TotalCapExceeded,
    #[msg("Vault balance is too low for this pull")]
    InsufficientVault,
    #[msg("Too many payees")]
    TooManyPayees,
    #[msg("Invalid mandate parameters")]
    InvalidMandate,
    #[msg("This pull cannot be restored")]
    NotRestorable,
    #[msg("Session key is not scoped for this kind of pull")]
    ScopeNotAllowed,
}
