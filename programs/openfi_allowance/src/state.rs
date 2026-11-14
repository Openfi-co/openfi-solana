use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const MANDATE_SEED: &[u8] = b"mandate";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SESSION_SEED: &[u8] = b"session";
pub const PULL_SEED: &[u8] = b"pull";

pub const MAX_PAYEES: usize = 8;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// OpenFi's executor. Only it may restore allowance after a fiat return.
    pub operator: Pubkey,
    pub bump: u8,
}

/// The enforceable subset of the canonical OpenFi mandate.
#[account]
#[derive(InitSpace)]
pub struct Mandate {
    /// sha256 of the off-chain mandate id.
    pub id: [u8; 32],
    pub principal: Pubkey,
    pub mint: Pubkey,
    #[max_len(MAX_PAYEES)]
    pub payees: Vec<Pubkey>,
    pub per_pull_cap: u64,
    pub epoch_seconds: i64,
    pub epoch_cap: u64,
    pub total_cap: u64,
    pub epoch_start: i64,
    pub spent_epoch: u64,
    pub spent_total: u64,
    pub expires_at: i64,
    /// Minimum identity level a payee must hold.
    pub required_level: u8,
    /// Bumped on update; intents signed against an older nonce are dead.
    pub nonce: u64,
    pub revoked: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Mandate {
    /// Roll the epoch forward if it has ended. Epochs stay aligned to the
    /// first epoch, so a late pull cannot shift the window. No keeper needed.
    pub fn roll_epoch(&mut self, now: i64) {
        if now - self.epoch_start >= self.epoch_seconds {
            let elapsed = (now - self.epoch_start) / self.epoch_seconds;
            self.epoch_start += elapsed * self.epoch_seconds;
            self.spent_epoch = 0;
        }
    }
}

/// An agent's scoped key under one mandate.
#[account]
#[derive(InitSpace)]
pub struct SessionKey {
    pub mandate: Pubkey,
    /// Agent's ed25519 public key. The agent never signs a transaction.
    pub pubkey: Pubkey,
    /// Per-epoch spend limit for this key, never above the mandate's.
    pub sub_cap: u64,
    pub expires_at: i64,
    pub revoked: bool,
    pub spent_epoch: u64,
    /// The mandate epoch `spent_epoch` belongs to.
    pub epoch_start: i64,
    pub bump: u8,
}

/// One per pull ref. Its existence makes a repeated ref fail.
#[account]
#[derive(InitSpace)]
pub struct PullRecord {
    pub mandate: Pubkey,
    pub session: Pubkey,
    pub ref_hash: [u8; 32],
    pub amount: u64,
    pub epoch_start: i64,
    /// Tokens left the vault (`execute_pull`). An executed pull cannot be restored.
    pub executed: bool,
    pub restored: bool,
    pub bump: u8,
}

/// What the agent signs. Encoded by `PullIntent::message`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PullIntent {
    pub payee: Pubkey,
    pub amount: u64,
    pub ref_hash: [u8; 32],
    pub nonce: u64,
    pub expires_at: i64,
}

pub const INTENT_DOMAIN: &[u8] = b"OPENFI_PULL_V1";
pub const INTENT_LEN: usize = 14 + 32 + 32 + 8 + 32 + 8 + 8;

impl PullIntent {
    /// `OPENFI_PULL_V1 | mandate | payee | amount u64 LE | ref_hash | nonce u64 LE | expires_at i64 LE`.
    /// The mandate address binds the signature to this program and mandate.
    pub fn message(&self, mandate: &Pubkey) -> [u8; INTENT_LEN] {
        let mut m = [0u8; INTENT_LEN];
        let mut o = 0;
        for part in [
            INTENT_DOMAIN,
            mandate.as_ref(),
            self.payee.as_ref(),
            &self.amount.to_le_bytes(),
            &self.ref_hash,
            &self.nonce.to_le_bytes(),
            &self.expires_at.to_le_bytes(),
        ] {
            m[o..o + part.len()].copy_from_slice(part);
            o += part.len();
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mandate(epoch_start: i64) -> Mandate {
        Mandate {
            id: [0; 32],
            principal: Pubkey::default(),
            mint: Pubkey::default(),
            payees: vec![],
            per_pull_cap: 10,
            epoch_seconds: 100,
            epoch_cap: 50,
            total_cap: 1000,
            epoch_start,
            spent_epoch: 40,
            spent_total: 40,
            expires_at: i64::MAX,
            required_level: 0,
            nonce: 0,
            revoked: false,
            bump: 0,
            vault_bump: 0,
        }
    }

    #[test]
    fn epoch_holds_inside_window() {
        let mut m = mandate(1000);
        m.roll_epoch(1099);
        assert_eq!((m.epoch_start, m.spent_epoch), (1000, 40));
    }

    #[test]
    fn epoch_rolls_at_boundary() {
        let mut m = mandate(1000);
        m.roll_epoch(1100);
        assert_eq!((m.epoch_start, m.spent_epoch, m.spent_total), (1100, 0, 40));
    }

    #[test]
    fn epoch_stays_aligned_after_gaps() {
        let mut m = mandate(1000);
        m.roll_epoch(1350);
        assert_eq!(m.epoch_start, 1300);
    }

    #[test]
    fn intent_message_layout() {
        let i = PullIntent { payee: Pubkey::new_from_array([2; 32]), amount: 7, ref_hash: [3; 32], nonce: 9, expires_at: -1 };
        let msg = i.message(&Pubkey::new_from_array([1; 32]));
        assert_eq!(&msg[..14], INTENT_DOMAIN);
        assert_eq!(&msg[14..46], &[1; 32]);
        assert_eq!(&msg[46..78], &[2; 32]);
        assert_eq!(&msg[78..86], &7u64.to_le_bytes());
        assert_eq!(&msg[86..118], &[3; 32]);
        assert_eq!(&msg[118..126], &9u64.to_le_bytes());
        assert_eq!(&msg[126..134], &(-1i64).to_le_bytes());
    }
}
