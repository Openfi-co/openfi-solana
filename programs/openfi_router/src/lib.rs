use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("d85jMjdA3wUtjeD1wBuAarMMcYczSmNyWajJSxpW7UL");

pub const ROUTER_SEED: &[u8] = b"router";
pub const INVENTORY_SEED: &[u8] = b"inventory";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";

/// The allowance program, whose pull records `settle_pull` reads. Not a crate
/// dependency: the allowance program already depends on this one (for
/// `refund`), so the record is decoded here from its account data.
pub const ALLOWANCE_PROGRAM_ID: Pubkey = pubkey!("9BNvSF8bUEQJaBbWxBmtjRnBH1qmM47JpWWDwKM8Cs1B");
/// Anchor discriminator of the allowance program's `PullRecord` account. A unit
/// test in the allowance crate checks it, and the layout below, against the real type.
pub const PULL_RECORD_DISCRIMINATOR: [u8; 8] = [167, 170, 127, 214, 16, 95, 163, 211];

/// Anchor discriminator of the allowance program's `Mandate` account (checked
/// against the real type by the same unit test).
pub const MANDATE_DISCRIMINATOR: [u8; 8] = [113, 216, 98, 159, 185, 63, 55, 18];
/// The allowance program's vault seed: a mandate's vault is
/// `["vault", mandate]` under the allowance program.
pub const ALLOWANCE_VAULT_SEED: &[u8] = b"vault";

/// Layout of the allowance program's `Mandate`, after the discriminator.
#[derive(AnchorDeserialize)]
pub struct MandateView {
    pub id: [u8; 32],
    pub principal: Pubkey,
    pub mint: Pubkey,
    pub payees: Vec<Pubkey>,
    pub per_pull_cap: u64,
    pub epoch_seconds: i64,
    pub epoch_cap: u64,
    pub total_cap: u64,
    pub epoch_start: i64,
    pub spent_epoch: u64,
    pub spent_total: u64,
    pub expires_at: i64,
    pub required_level: u8,
    pub nonce: u64,
    pub revoked: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Layout of the allowance program's `PullRecord`, after the discriminator.
#[derive(AnchorDeserialize)]
pub struct PullRecordView {
    pub mandate: Pubkey,
    pub session: Pubkey,
    pub ref_hash: [u8; 32],
    pub amount: u64,
    pub epoch_start: i64,
    pub executed: bool,
    pub restored: bool,
    pub bump: u8,
    pub payee: Pubkey,
}

/// SettlementRouter: once fiat clears off-chain, pays stablecoin from OpenFi's
/// inventory into a mandate's vault (`settle`) or to an authorised pull's
/// payee (`settle_pull`), never to an arbitrary account. Idempotent by `ref`: the `Settlement` record
/// is created on first settle, so a repeated ref can never pay twice. If the
/// fiat leg is later reversed (a bank debit returns), `refund` sends the
/// stablecoin back to inventory against the same record.
#[program]
pub mod openfi_router {
    use super::*;

    pub fn init_router(ctx: Context<InitRouter>, authority: Pubkey) -> Result<()> {
        ctx.accounts.config.set_inner(RouterConfig {
            authority,
            mint: ctx.accounts.mint.key(),
            bump: ctx.bumps.config,
            inventory_bump: ctx.bumps.inventory,
        });
        Ok(())
    }

    pub fn set_authority(ctx: Context<SetAuthority>, authority: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = authority;
        Ok(())
    }

    /// Fund a mandate's vault once its bank debit has cleared. `ref_hash` is
    /// sha256 of the payment ref (the bank charge ID). Pays only into the vault
    /// of a live mandate (allowance program, not revoked, not expired, same
    /// mint), never to an arbitrary account.
    pub fn settle(ctx: Context<Settle>, ref_hash: [u8; 32], amount: u64) -> Result<()> {
        require!(amount > 0, RouterError::InvalidAmount);
        let mandate = read_mandate(&ctx.accounts.mandate)?;
        require!(!mandate.revoked, RouterError::MandateRevoked);
        require!(Clock::get()?.unix_timestamp < mandate.expires_at, RouterError::MandateExpired);
        require_keys_eq!(mandate.mint, ctx.accounts.mint.key(), RouterError::NotAMandateVault);
        let vault = Pubkey::create_program_address(
            &[ALLOWANCE_VAULT_SEED, ctx.accounts.mandate.key.as_ref(), &[mandate.vault_bump]],
            &ALLOWANCE_PROGRAM_ID,
        )
        .map_err(|_| error!(RouterError::NotAMandateVault))?;
        require_keys_eq!(ctx.accounts.destination.key(), vault, RouterError::NotAMandateVault);
        require!(ctx.accounts.inventory.amount >= amount, RouterError::InsufficientInventory);

        let seeds: &[&[u8]] = &[ROUTER_SEED, &[ctx.accounts.config.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.inventory.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.settlement.set_inner(Settlement {
            ref_hash,
            destination: ctx.accounts.destination.key(),
            amount,
            settled_at: now,
            bump: ctx.bumps.settlement,
            refunded: 0,
        });
        emit!(Settled {
            ref_hash,
            mint: ctx.accounts.mint.key(),
            destination: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }

    /// Pay an authorized pull: the Web2 path, `authorize_pull` → fiat clears →
    /// this. Pays only if the allowance program holds a pull record for this
    /// ref that is still open (not executed from the vault, not restored), only
    /// to that record's payee, and exactly its amount. Once per ref.
    pub fn settle_pull(ctx: Context<SettlePull>, ref_hash: [u8; 32]) -> Result<()> {
        let pull = read_pull_record(&ctx.accounts.pull)?;
        require!(pull.ref_hash == ref_hash, RouterError::NotAnAuthorizedPull);
        require!(!pull.executed && !pull.restored, RouterError::PullNotSettleable);
        require_keys_eq!(ctx.accounts.destination.owner, pull.payee, RouterError::WrongPayee);
        require!(ctx.accounts.inventory.amount >= pull.amount, RouterError::InsufficientInventory);

        let seeds: &[&[u8]] = &[ROUTER_SEED, &[ctx.accounts.config.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.inventory.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            pull.amount,
            ctx.accounts.mint.decimals,
        )?;

        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.settlement.set_inner(Settlement {
            ref_hash,
            destination: ctx.accounts.destination.key(),
            amount: pull.amount,
            settled_at: now,
            bump: ctx.bumps.settlement,
            refunded: 0,
        });
        emit!(PullSettled { ref_hash, mandate: pull.mandate, payee: pull.payee, amount: pull.amount });
        Ok(())
    }

    /// Return settled stablecoin to inventory after the fiat leg was reversed.
    /// Funds can only come back from the account the settlement paid, signed by
    /// that account's owner (for a mandate vault, the allowance program signs
    /// as the mandate). Partial refunds add up; the total never exceeds what
    /// was settled.
    pub fn refund(ctx: Context<Refund>, amount: u64) -> Result<()> {
        require!(amount > 0, RouterError::InvalidAmount);
        let settlement = &ctx.accounts.settlement;
        let refunded = settlement
            .refunded
            .checked_add(amount)
            .filter(|r| *r <= settlement.amount)
            .ok_or(RouterError::RefundExceedsSettlement)?;

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.inventory.to_account_info(),
                    authority: ctx.accounts.source_authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let settlement = &mut ctx.accounts.settlement;
        settlement.refunded = refunded;
        emit!(Refunded {
            ref_hash: settlement.ref_hash,
            source: ctx.accounts.source.key(),
            amount,
            refunded,
        });
        Ok(())
    }
}

/// Decode an allowance `Mandate`, refusing anything else.
fn read_mandate(info: &AccountInfo) -> Result<MandateView> {
    require_keys_eq!(*info.owner, ALLOWANCE_PROGRAM_ID, RouterError::NotAMandateVault);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 8 && data[..8] == MANDATE_DISCRIMINATOR, RouterError::NotAMandateVault);
    MandateView::deserialize(&mut &data[8..]).map_err(|_| error!(RouterError::NotAMandateVault))
}

/// Decode an allowance `PullRecord`, refusing anything else: wrong owner,
/// wrong discriminator or bad data.
fn read_pull_record(info: &AccountInfo) -> Result<PullRecordView> {
    require_keys_eq!(*info.owner, ALLOWANCE_PROGRAM_ID, RouterError::NotAnAuthorizedPull);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 8 && data[..8] == PULL_RECORD_DISCRIMINATOR, RouterError::NotAnAuthorizedPull);
    PullRecordView::deserialize(&mut &data[8..]).map_err(|_| error!(RouterError::NotAnAuthorizedPull))
}

#[account]
#[derive(InitSpace)]
pub struct RouterConfig {
    /// Settlement authority (production: a threshold multisig).
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
    pub inventory_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub ref_hash: [u8; 32],
    pub destination: Pubkey,
    pub amount: u64,
    pub settled_at: i64,
    pub bump: u8,
    /// Total returned to inventory by `refund`.
    pub refunded: u64,
}

#[derive(Accounts)]
pub struct InitRouter<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + RouterConfig::INIT_SPACE, seeds = [ROUTER_SEED], bump)]
    pub config: Account<'info, RouterConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [INVENTORY_SEED],
        bump,
        token::mint = mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub inventory: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [ROUTER_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
#[instruction(ref_hash: [u8; 32])]
pub struct Settle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ROUTER_SEED], bump = config.bump, has_one = authority, has_one = mint)]
    pub config: Account<'info, RouterConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [INVENTORY_SEED], bump = config.inventory_bump)]
    pub inventory: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: decoded and validated in `read_mandate` (owner, discriminator, contents).
    pub mandate: UncheckedAccount<'info>,
    /// The mandate's vault; checked against its address in `settle`.
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        space = 8 + Settlement::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, ref_hash.as_ref()],
        bump
    )]
    pub settlement: Account<'info, Settlement>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ref_hash: [u8; 32])]
pub struct SettlePull<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ROUTER_SEED], bump = config.bump, has_one = authority, has_one = mint)]
    pub config: Account<'info, RouterConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [INVENTORY_SEED], bump = config.inventory_bump)]
    pub inventory: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: decoded and validated in `read_pull_record` (owner, discriminator, contents).
    pub pull: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        space = 8 + Settlement::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, ref_hash.as_ref()],
        bump
    )]
    pub settlement: Account<'info, Settlement>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Owner of the account the settlement paid into.
    pub source_authority: Signer<'info>,
    #[account(seeds = [ROUTER_SEED], bump = config.bump, has_one = mint)]
    pub config: Account<'info, RouterConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [INVENTORY_SEED], bump = config.inventory_bump)]
    pub inventory: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [SETTLEMENT_SEED, settlement.ref_hash.as_ref()], bump = settlement.bump)]
    pub settlement: Account<'info, Settlement>,
    #[account(
        mut,
        address = settlement.destination,
        token::mint = mint,
        token::authority = source_authority,
        token::token_program = token_program,
    )]
    pub source: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct Settled {
    pub ref_hash: [u8; 32],
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PullSettled {
    pub ref_hash: [u8; 32],
    pub mandate: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Refunded {
    pub ref_hash: [u8; 32],
    pub source: Pubkey,
    pub amount: u64,
    /// Running total refunded against this settlement.
    pub refunded: u64,
}

/// Order matters: codes are 6000 + index. Append only.
#[error_code]
pub enum RouterError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Router inventory is too low for this settlement")]
    InsufficientInventory,
    #[msg("Refund would exceed the settled amount")]
    RefundExceedsSettlement,
    #[msg("Not an authorized pull record from the allowance program")]
    NotAnAuthorizedPull,
    #[msg("Pull was already executed from the vault or restored")]
    PullNotSettleable,
    #[msg("Destination is not the pull's payee")]
    WrongPayee,
    #[msg("Destination is not the vault of an allowance mandate")]
    NotAMandateVault,
    #[msg("Mandate has been revoked")]
    MandateRevoked,
    #[msg("Mandate has expired")]
    MandateExpired,
}
