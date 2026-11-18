use anchor_lang::prelude::*;

pub const REGISTRY_SEED: &[u8] = b"registry";
pub const CREDENTIAL_SEED: &[u8] = b"credential";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
pub const STATUS_SEED: &[u8] = b"status";

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

/// The on-chain anchor of the issuer's off-chain credential status list
/// (revocations of VC-JWTs). Relying parties check a credential's status
/// entry against this root. On-chain gating does not wait for it:
/// `revoke_credential` takes effect in `assert_human` immediately.
#[account]
#[derive(InitSpace)]
pub struct StatusList {
    /// Root (hash) of the current status list.
    pub root: [u8; 32],
    /// Strictly increasing; an older list can never be re-published.
    pub version: u64,
    pub updated_at: i64,
    pub bump: u8,
}
