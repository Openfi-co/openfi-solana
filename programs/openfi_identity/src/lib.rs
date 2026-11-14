pub mod error;
pub mod state;

use anchor_lang::prelude::*;

pub use error::IdentityError;
pub use state::*;

declare_id!("8LeyKvcY9XkHYt6WePMdwc8cpRHCoXsVqkXY1QJ7Q5Yo");

/// IdentityRegistry: anchors credential commitments and gates the other
/// OpenFi programs through `assert_human`.
#[program]
pub mod openfi_identity {
    use super::*;

    pub fn init_registry(ctx: Context<InitRegistry>, issuer: Pubkey) -> Result<()> {
        ctx.accounts.registry.set_inner(Registry {
            admin: ctx.accounts.admin.key(),
            issuer,
            bump: ctx.bumps.registry,
        });
        Ok(())
    }

    pub fn set_issuer(ctx: Context<SetIssuer>, issuer: Pubkey) -> Result<()> {
        ctx.accounts.registry.issuer = issuer;
        Ok(())
    }

    pub fn anchor_credential(
        ctx: Context<AnchorCredential>,
        subject: Pubkey,
        commitment: [u8; 32],
        level: u8,
        expires_at: i64,
        nullifier: [u8; 32],
    ) -> Result<()> {
        require!(level <= LEVEL_BANK_VERIFIED, IdentityError::InvalidLevel);
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, IdentityError::InvalidExpiry);

        let record = &mut ctx.accounts.nullifier_record;
        require!(
            record.subject == Pubkey::default() || record.subject == subject,
            IdentityError::DuplicateIdentity
        );
        record.subject = subject;
        record.bump = ctx.bumps.nullifier_record;

        ctx.accounts.credential.set_inner(CredentialAnchor {
            subject,
            commitment,
            level,
            issued_at: now,
            expires_at,
            nullifier,
            revoked: false,
            bump: ctx.bumps.credential,
        });
        emit!(CredentialAnchored { subject, level, expires_at });
        Ok(())
    }

    pub fn revoke_credential(ctx: Context<RevokeCredential>) -> Result<()> {
        ctx.accounts.credential.revoked = true;
        emit!(CredentialRevoked { subject: ctx.accounts.credential.subject });
        Ok(())
    }

    /// CPI gate. Fails with `IdentityRequired` unless `subject` holds an
    /// unrevoked, unexpired credential at `min_level` or above.
    pub fn assert_human(ctx: Context<AssertHuman>, min_level: u8) -> Result<()> {
        check_human(&ctx.accounts.credential, &ctx.accounts.subject.key(), min_level)
    }
}

/// The rule behind `assert_human`. The credential account is unchecked so a
/// missing credential is a clean `IdentityRequired`, not a deserialize error.
pub fn check_human(credential: &AccountInfo, subject: &Pubkey, min_level: u8) -> Result<()> {
    if min_level == LEVEL_NONE {
        return Ok(());
    }
    let (expected, _) = Pubkey::find_program_address(&[CREDENTIAL_SEED, subject.as_ref()], &crate::ID);
    require_keys_eq!(credential.key(), expected, IdentityError::IdentityRequired);
    if credential.owner != &crate::ID || credential.data_is_empty() {
        return err!(IdentityError::IdentityRequired);
    }
    let data = credential.try_borrow_data()?;
    let anchor = CredentialAnchor::try_deserialize(&mut &data[..])
        .map_err(|_| error!(IdentityError::IdentityRequired))?;
    let now = Clock::get()?.unix_timestamp;
    require!(
        !anchor.revoked && anchor.expires_at > now && anchor.level >= min_level,
        IdentityError::IdentityRequired
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Registry::INIT_SPACE, seeds = [REGISTRY_SEED], bump)]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetIssuer<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump, has_one = admin)]
    pub registry: Account<'info, Registry>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey, commitment: [u8; 32], level: u8, expires_at: i64, nullifier: [u8; 32])]
pub struct AnchorCredential<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump, has_one = issuer)]
    pub registry: Account<'info, Registry>,
    #[account(
        init_if_needed,
        payer = issuer,
        space = 8 + CredentialAnchor::INIT_SPACE,
        seeds = [CREDENTIAL_SEED, subject.as_ref()],
        bump
    )]
    pub credential: Account<'info, CredentialAnchor>,
    #[account(
        init_if_needed,
        payer = issuer,
        space = 8 + NullifierRecord::INIT_SPACE,
        seeds = [NULLIFIER_SEED, nullifier.as_ref()],
        bump
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeCredential<'info> {
    pub issuer: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump, has_one = issuer)]
    pub registry: Account<'info, Registry>,
    #[account(mut, seeds = [CREDENTIAL_SEED, credential.subject.as_ref()], bump = credential.bump)]
    pub credential: Account<'info, CredentialAnchor>,
}

#[derive(Accounts)]
pub struct AssertHuman<'info> {
    /// CHECK: validated in `check_human` (PDA, owner, contents).
    pub credential: UncheckedAccount<'info>,
    /// CHECK: only its address is used.
    pub subject: UncheckedAccount<'info>,
}

#[event]
pub struct CredentialAnchored {
    pub subject: Pubkey,
    pub level: u8,
    pub expires_at: i64,
}

#[event]
pub struct CredentialRevoked {
    pub subject: Pubkey,
}
