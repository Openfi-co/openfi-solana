use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("d85jMjdA3wUtjeD1wBuAarMMcYczSmNyWajJSxpW7UL");

pub const ROUTER_SEED: &[u8] = b"router";
pub const INVENTORY_SEED: &[u8] = b"inventory";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";

/// SettlementRouter: once fiat clears off-chain, pays stablecoin from OpenFi's
/// inventory to the destination. Idempotent by `ref`: the `Settlement` record
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

    /// `ref_hash` is sha256 of the payment ref (the bank charge ID).
    pub fn settle(ctx: Context<Settle>, ref_hash: [u8; 32], amount: u64) -> Result<()> {
        require!(amount > 0, RouterError::InvalidAmount);
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
}
