use anchor_lang::prelude::*;

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
}
