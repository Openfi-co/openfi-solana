pub mod error;
pub mod state;

use anchor_lang::prelude::*;
use anchor_lang::compat::solana_instructions_sysvar as ix_sysvar;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};
use openfi_identity::program::OpenfiIdentity;

pub use error::AllowanceError;
pub use state::*;

declare_id!("9BNvSF8bUEQJaBbWxBmtjRnBH1qmM47JpWWDwKM8Cs1B");

/// Ed25519 signature-verification precompile.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// AllowanceStateMachine: mandates, session keys, epoch accounting and pulls.
///
/// An agent never signs a transaction. It signs a `PullIntent` with its session
/// key; OpenFi's executor submits it with an ed25519 precompile instruction in
/// front, pays the fees, and this program checks that signature against the
/// `SessionKey` account before spending allowance.
#[program]
pub mod openfi_allowance {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, operator: Pubkey) -> Result<()> {
        ctx.accounts.config.set_inner(Config {
            admin: ctx.accounts.admin.key(),
            operator,
            bump: ctx.bumps.config,
        });
        Ok(())
    }

    pub fn create_mandate(ctx: Context<CreateMandate>, args: CreateMandateArgs) -> Result<()> {
        require!(args.payees.len() <= MAX_PAYEES, AllowanceError::TooManyPayees);
        let now = Clock::get()?.unix_timestamp;
        require!(
            args.per_pull_cap > 0
                && args.epoch_cap > 0
                && args.total_cap > 0
                && args.epoch_seconds > 0
                && args.expires_at > now
                && args.required_level <= openfi_identity::LEVEL_BANK_VERIFIED,
            AllowanceError::InvalidMandate
        );

        // The principal must be a verified human. Identity program decides.
        openfi_identity::cpi::assert_human(
            CpiContext::new(
                ctx.accounts.identity_program.key(),
                openfi_identity::cpi::accounts::AssertHuman {
                    credential: ctx.accounts.principal_credential.to_account_info(),
                    subject: ctx.accounts.principal.to_account_info(),
                },
            ),
            openfi_identity::LEVEL_BANK_VERIFIED,
        )?;

        ctx.accounts.mandate.set_inner(Mandate {
            id: args.id,
            principal: ctx.accounts.principal.key(),
            mint: ctx.accounts.mint.key(),
            payees: args.payees,
            per_pull_cap: args.per_pull_cap,
            epoch_seconds: args.epoch_seconds,
            epoch_cap: args.epoch_cap,
            total_cap: args.total_cap,
            epoch_start: now,
            spent_epoch: 0,
            spent_total: 0,
            expires_at: args.expires_at,
            required_level: args.required_level,
            nonce: args.nonce,
            revoked: false,
            bump: ctx.bumps.mandate,
            vault_bump: ctx.bumps.vault,
        });
        emit!(MandateCreated {
            mandate: ctx.accounts.mandate.key(),
            principal: ctx.accounts.principal.key(),
            epoch_cap: args.epoch_cap,
            epoch_seconds: args.epoch_seconds,
            expires_at: args.expires_at,
        });
        Ok(())
    }

    pub fn revoke_mandate(ctx: Context<PrincipalOnly>) -> Result<()> {
        ctx.accounts.mandate.revoked = true;
        emit!(MandateRevoked { mandate: ctx.accounts.mandate.key() });
        Ok(())
    }

    pub fn issue_session(ctx: Context<IssueSession>, pubkey: Pubkey, sub_cap: u64, expires_at: i64) -> Result<()> {
        let mandate = &ctx.accounts.mandate;
        require!(sub_cap > 0 && sub_cap <= mandate.epoch_cap, AllowanceError::InvalidMandate);
        ctx.accounts.session.set_inner(SessionKey {
            mandate: mandate.key(),
            pubkey,
            sub_cap,
            expires_at,
            revoked: false,
            spent_epoch: 0,
            epoch_start: mandate.epoch_start,
            bump: ctx.bumps.session,
        });
        emit!(SessionIssued { mandate: mandate.key(), pubkey, sub_cap, expires_at });
        Ok(())
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        ctx.accounts.session.revoked = true;
        emit!(SessionRevoked { mandate: ctx.accounts.mandate.key(), pubkey: ctx.accounts.session.pubkey });
        Ok(())
    }

    /// Web2 pull: spend allowance and emit `PullAuthorized`. Moves no tokens;
    /// OpenFi moves fiat only after this succeeds.
    pub fn authorize_pull(mut ctx: Context<AuthorizePull>, intent: PullIntent, session_pubkey: Pubkey) -> Result<()> {
        let a = &mut ctx.accounts;
        let epoch_start = consume(
            &mut a.mandate,
            &a.session,
            &a.instructions,
            &a.payee_credential,
            &a.payee,
            &a.identity_program,
            &intent,
            &session_pubkey,
        )?;
        a.pull.set_inner(PullRecord {
            mandate: a.mandate.key(),
            session: session_pubkey,
            ref_hash: intent.ref_hash,
            amount: intent.amount,
            epoch_start,
            executed: false,
            restored: false,
            bump: ctx.bumps.pull,
        });
        emit!(PullAuthorized { mandate: a.mandate.key(), payee: intent.payee, amount: intent.amount, ref_hash: intent.ref_hash });
        Ok(())
    }

    /// Web3 pull: authorize, then transfer from the mandate's vault to the payee.
    pub fn execute_pull(mut ctx: Context<ExecutePull>, intent: PullIntent, session_pubkey: Pubkey) -> Result<()> {
        let a = &mut ctx.accounts;
        let epoch_start = consume(
            &mut a.mandate,
            &a.session,
            &a.instructions,
            &a.payee_credential,
            &a.payee,
            &a.identity_program,
            &intent,
            &session_pubkey,
        )?;
        require!(a.vault.amount >= intent.amount, AllowanceError::InsufficientVault);

        let id = a.mandate.id;
        let seeds: &[&[u8]] = &[MANDATE_SEED, &id, &[a.mandate.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.payee_token.to_account_info(),
                    authority: a.mandate.to_account_info(),
                },
                &[seeds],
            ),
            intent.amount,
            a.mint.decimals,
        )?;

        a.pull.set_inner(PullRecord {
            mandate: a.mandate.key(),
            session: session_pubkey,
            ref_hash: intent.ref_hash,
            amount: intent.amount,
            epoch_start,
            executed: true,
            restored: false,
            bump: ctx.bumps.pull,
        });
        emit!(PullExecuted { mandate: a.mandate.key(), payee: intent.payee, amount: intent.amount, ref_hash: intent.ref_hash });
        Ok(())
    }

    /// Saga compensation: the fiat leg of an authorized pull returned or
    /// failed, so give the allowance back. Operator only; executed pulls (tokens
    /// already moved) are not restorable.
    pub fn restore_allowance(ctx: Context<RestoreAllowance>) -> Result<()> {
        let pull = &mut ctx.accounts.pull;
        require!(!pull.executed && !pull.restored, AllowanceError::NotRestorable);
        pull.restored = true;

        let mandate = &mut ctx.accounts.mandate;
        mandate.spent_total = mandate.spent_total.saturating_sub(pull.amount);
        if mandate.epoch_start == pull.epoch_start {
            mandate.spent_epoch = mandate.spent_epoch.saturating_sub(pull.amount);
        }
        let session = &mut ctx.accounts.session;
        if session.epoch_start == pull.epoch_start {
            session.spent_epoch = session.spent_epoch.saturating_sub(pull.amount);
        }
        emit!(AllowanceRestored { mandate: mandate.key(), amount: pull.amount, ref_hash: pull.ref_hash });
        Ok(())
    }
}

/// Every pull check, in fixed order. Returns the epoch the spend landed in.
#[allow(clippy::too_many_arguments)]
fn consume<'info>(
    mandate: &mut Account<'info, Mandate>,
    session_info: &UncheckedAccount<'info>,
    instructions: &UncheckedAccount<'info>,
    payee_credential: &UncheckedAccount<'info>,
    payee: &UncheckedAccount<'info>,
    identity_program: &Program<'info, OpenfiIdentity>,
    intent: &PullIntent,
    session_pubkey: &Pubkey,
) -> Result<i64> {
    let now = Clock::get()?.unix_timestamp;
    require!(intent.amount > 0, AllowanceError::InvalidAmount);
    require!(!mandate.revoked, AllowanceError::MandateRevoked);
    require!(now < mandate.expires_at, AllowanceError::MandateExpired);

    // The session account is unchecked so a missing key is a clean
    // `UnknownSession`, not a generic "account not initialized".
    if session_info.owner != &crate::ID || session_info.data_is_empty() {
        return err!(AllowanceError::UnknownSession);
    }
    let mut session = {
        let data = session_info.try_borrow_data()?;
        SessionKey::try_deserialize(&mut &data[..]).map_err(|_| error!(AllowanceError::UnknownSession))?
    };
    require!(!session.revoked, AllowanceError::SessionRevoked);
    require!(now < session.expires_at, AllowanceError::SessionExpired);

    verify_intent_signature(instructions, session_pubkey, &intent.message(&mandate.key()))?;
    require!(intent.nonce == mandate.nonce, AllowanceError::StaleNonce);
    require!(now < intent.expires_at, AllowanceError::IntentExpired);

    require!(mandate.payees.contains(&intent.payee), AllowanceError::PayeeNotAllowed);
    openfi_identity::cpi::assert_human(
        CpiContext::new(
            identity_program.key(),
            openfi_identity::cpi::accounts::AssertHuman {
                credential: payee_credential.to_account_info(),
                subject: payee.to_account_info(),
            },
        ),
        mandate.required_level,
    )?;

    mandate.roll_epoch(now);
    if session.epoch_start != mandate.epoch_start {
        session.epoch_start = mandate.epoch_start;
        session.spent_epoch = 0;
    }
    require!(intent.amount <= mandate.per_pull_cap, AllowanceError::PerPullCapExceeded);
    require!(
        mandate.spent_epoch.checked_add(intent.amount).is_some_and(|s| s <= mandate.epoch_cap),
        AllowanceError::EpochCapExceeded
    );
    require!(
        session.spent_epoch.checked_add(intent.amount).is_some_and(|s| s <= session.sub_cap),
        AllowanceError::SessionCapExceeded
    );
    require!(
        mandate.spent_total.checked_add(intent.amount).is_some_and(|s| s <= mandate.total_cap),
        AllowanceError::TotalCapExceeded
    );

    mandate.spent_epoch += intent.amount;
    mandate.spent_total += intent.amount;
    session.spent_epoch += intent.amount;
    let mut data = session_info.try_borrow_mut_data()?;
    session.try_serialize(&mut &mut data[..])?;
    Ok(mandate.epoch_start)
}

/// Require that the instruction just before this one is an ed25519 precompile
/// call verifying exactly `message` under `pubkey`. The precompile has already
/// checked the signature itself (the transaction fails otherwise); here we only
/// bind it to this session key and this intent.
fn verify_intent_signature(instructions: &AccountInfo, pubkey: &Pubkey, message: &[u8]) -> Result<()> {
    let current = ix_sysvar::load_current_index_checked(instructions)?;
    require!(current > 0, AllowanceError::BadSignature);
    let ix = ix_sysvar::load_instruction_at_checked((current - 1) as usize, instructions)?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, AllowanceError::BadSignature);

    let d = &ix.data;
    // Header: count (u8), padding (u8), then one 14-byte offsets block.
    require!(d.len() >= 16 && d[0] == 1, AllowanceError::BadSignature);
    let u16_at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) =
        (u16_at(4), u16_at(6), u16_at(8), u16_at(10), u16_at(12), u16_at(14));
    // Every piece must live in the precompile instruction itself.
    require!(
        sig_ix == u16::MAX as usize && pk_ix == u16::MAX as usize && msg_ix == u16::MAX as usize,
        AllowanceError::BadSignature
    );
    require!(
        d.len() >= pk_off + 32 && d.len() >= msg_off + msg_len,
        AllowanceError::BadSignature
    );
    require!(&d[pk_off..pk_off + 32] == pubkey.as_ref(), AllowanceError::BadSignature);
    require!(&d[msg_off..msg_off + msg_len] == message, AllowanceError::BadSignature);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateMandateArgs {
    pub id: [u8; 32],
    pub payees: Vec<Pubkey>,
    pub per_pull_cap: u64,
    pub epoch_seconds: i64,
    pub epoch_cap: u64,
    pub total_cap: u64,
    pub expires_at: i64,
    pub required_level: u8,
    pub nonce: u64,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: CreateMandateArgs)]
pub struct CreateMandate<'info> {
    /// Pays rent, so the principal needs no SOL.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub principal: Signer<'info>,
    /// CHECK: checked by the identity program's `assert_human`.
    pub principal_credential: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [MANDATE_SEED, args.id.as_ref()],
        bump
    )]
    pub mandate: Account<'info, Mandate>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, mandate.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = mandate,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub identity_program: Program<'info, OpenfiIdentity>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PrincipalOnly<'info> {
    pub principal: Signer<'info>,
    #[account(mut, seeds = [MANDATE_SEED, mandate.id.as_ref()], bump = mandate.bump, has_one = principal)]
    pub mandate: Account<'info, Mandate>,
}

#[derive(Accounts)]
#[instruction(pubkey: Pubkey)]
pub struct IssueSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub principal: Signer<'info>,
    #[account(seeds = [MANDATE_SEED, mandate.id.as_ref()], bump = mandate.bump, has_one = principal)]
    pub mandate: Account<'info, Mandate>,
    #[account(
        init,
        payer = payer,
        space = 8 + SessionKey::INIT_SPACE,
        seeds = [SESSION_SEED, mandate.key().as_ref(), pubkey.as_ref()],
        bump
    )]
    pub session: Account<'info, SessionKey>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    pub principal: Signer<'info>,
    #[account(seeds = [MANDATE_SEED, mandate.id.as_ref()], bump = mandate.bump, has_one = principal)]
    pub mandate: Account<'info, Mandate>,
    #[account(mut, seeds = [SESSION_SEED, mandate.key().as_ref(), session.pubkey.as_ref()], bump = session.bump, has_one = mandate)]
    pub session: Account<'info, SessionKey>,
}

#[derive(Accounts)]
#[instruction(intent: PullIntent, session_pubkey: Pubkey)]
pub struct AuthorizePull<'info> {
    /// OpenFi's executor: submits and pays. Holds no authority over funds.
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut, seeds = [MANDATE_SEED, mandate.id.as_ref()], bump = mandate.bump)]
    pub mandate: Account<'info, Mandate>,
    /// CHECK: loaded and validated in `consume`.
    #[account(mut, seeds = [SESSION_SEED, mandate.key().as_ref(), session_pubkey.as_ref()], bump)]
    pub session: UncheckedAccount<'info>,
    #[account(
        init,
        payer = executor,
        space = 8 + PullRecord::INIT_SPACE,
        seeds = [PULL_SEED, mandate.key().as_ref(), intent.ref_hash.as_ref()],
        bump
    )]
    pub pull: Account<'info, PullRecord>,
    /// CHECK: must be the intent's payee; its credential is checked by the identity program.
    #[account(address = intent.payee)]
    pub payee: UncheckedAccount<'info>,
    /// CHECK: checked by the identity program's `assert_human`.
    pub payee_credential: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub identity_program: Program<'info, OpenfiIdentity>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(intent: PullIntent, session_pubkey: Pubkey)]
pub struct ExecutePull<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut, seeds = [MANDATE_SEED, mandate.id.as_ref()], bump = mandate.bump, has_one = mint)]
    pub mandate: Account<'info, Mandate>,
    /// CHECK: loaded and validated in `consume`.
    #[account(mut, seeds = [SESSION_SEED, mandate.key().as_ref(), session_pubkey.as_ref()], bump)]
    pub session: UncheckedAccount<'info>,
    #[account(
        init,
        payer = executor,
        space = 8 + PullRecord::INIT_SPACE,
        seeds = [PULL_SEED, mandate.key().as_ref(), intent.ref_hash.as_ref()],
        bump
    )]
    pub pull: Account<'info, PullRecord>,
    /// CHECK: must be the intent's payee; its credential is checked by the identity program.
    #[account(address = intent.payee)]
    pub payee: UncheckedAccount<'info>,
    /// CHECK: checked by the identity program's `assert_human`.
    pub payee_credential: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = payee, token::token_program = token_program)]
    pub payee_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED, mandate.key().as_ref()], bump = mandate.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: the instructions sysvar.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub identity_program: Program<'info, OpenfiIdentity>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RestoreAllowance<'info> {
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = operator)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MANDATE_SEED, mandate.id.as_ref()], bump = mandate.bump)]
    pub mandate: Account<'info, Mandate>,
    #[account(mut, seeds = [PULL_SEED, mandate.key().as_ref(), pull.ref_hash.as_ref()], bump = pull.bump, has_one = mandate)]
    pub pull: Account<'info, PullRecord>,
    #[account(mut, seeds = [SESSION_SEED, mandate.key().as_ref(), pull.session.as_ref()], bump = session.bump)]
    pub session: Account<'info, SessionKey>,
}

#[event]
pub struct MandateCreated {
    pub mandate: Pubkey,
    pub principal: Pubkey,
    pub epoch_cap: u64,
    pub epoch_seconds: i64,
    pub expires_at: i64,
}

#[event]
pub struct MandateRevoked {
    pub mandate: Pubkey,
}

#[event]
pub struct SessionIssued {
    pub mandate: Pubkey,
    pub pubkey: Pubkey,
    pub sub_cap: u64,
    pub expires_at: i64,
}

#[event]
pub struct SessionRevoked {
    pub mandate: Pubkey,
    pub pubkey: Pubkey,
}

#[event]
pub struct PullAuthorized {
    pub mandate: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
    pub ref_hash: [u8; 32],
}

#[event]
pub struct PullExecuted {
    pub mandate: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
    pub ref_hash: [u8; 32],
}

#[event]
pub struct AllowanceRestored {
    pub mandate: Pubkey,
    pub amount: u64,
    pub ref_hash: [u8; 32],
}
