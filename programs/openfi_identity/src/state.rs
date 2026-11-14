use anchor_lang::prelude::*;

pub const REGISTRY_SEED: &[u8] = b"registry";
pub const CREDENTIAL_SEED: &[u8] = b"credential";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

/// Identity levels, lowest first. Comparisons are numeric.
pub const LEVEL_NONE: u8 = 0;
pub const LEVEL_BANK_VERIFIED: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub admin: Pubkey,
    /// Signs credential anchors and revocations (OpenFi's issuer key).
    pub issuer: Pubkey,
    pub bump: u8,
}

/// One per subject wallet. Holds a commitment to the off-chain VC-JWT, never
/// the credential itself: no name, country or document number.
#[account]
#[derive(InitSpace)]
pub struct CredentialAnchor {
    pub subject: Pubkey,
    /// sha256 of the VC-JWT.
    pub commitment: [u8; 32],
    pub level: u8,
    pub issued_at: i64,
    pub expires_at: i64,
    pub nullifier: [u8; 32],
    pub revoked: bool,
    pub bump: u8,
}

/// One per verified bank identity. Its existence is what stops a second
/// wallet from claiming the same person.
#[account]
#[derive(InitSpace)]
pub struct NullifierRecord {
    pub subject: Pubkey,
    pub bump: u8,
}
