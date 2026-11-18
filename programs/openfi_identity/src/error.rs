use anchor_lang::prelude::*;

/// Order matters: codes are 6000 + index. Append only.
#[error_code]
pub enum IdentityError {
    #[msg("Subject has no valid credential at the required level")]
    IdentityRequired,
    #[msg("This identity is already bound to another wallet")]
    DuplicateIdentity,
    #[msg("Unknown identity level")]
    InvalidLevel,
    #[msg("Credential expiry must be in the future")]
    InvalidExpiry,
    #[msg("Status list version must be higher than the current one")]
    StaleStatusVersion,
}
