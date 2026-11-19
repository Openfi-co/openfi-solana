# OpenFi on Solana: identity, allowances and bank-funded settlement (devnet prototype)

OpenFi lets treasury teams and AI agents pull funds from bank accounts under on-chain spending limits, with cleared funds settling in USDC on Solana. This repository holds the Solana layer: three Anchor programs and a TypeScript adapter. An agent holds a session key that can only spend within a per-pull, per-day and total cap, before an expiry, to allowlisted payees that hold a valid credential, and only until the principal revokes it. Every one of those checks runs on-chain, so a pull that breaks the mandate is a failed transaction on the ledger.

Built on Flick's licensed open banking infrastructure.

## Status

| Part | State |
|---|---|
| Identity Registry (`openfi_identity`): credential commitments, one nullifier per verified person, revocation, `assert_human` gate called by CPI, status-list root (`rotate_status_root`) | **Real**, on devnet |
| Allowance State Machine (`openfi_allowance`): per-pull, per-epoch and total caps, expiry, payee allowlist, nonce, session keys with their own caps and scope (bank-side pulls, vault pulls or both), ed25519-signed pull intents, `authorize_pull` (bank side) and `execute_pull` (from the mandate's vault), `update_mandate` (bumps the nonce so old intents die), prefund `deposit`, `close` (pays the vault back to the principal), allowance restore and vault return after a returned debit | **Real**, on devnet |
| Settlement Router (`openfi_router`): pays USDC from OpenFi's float for a cleared bank debit, once per charge ID; `refund` sends it back to the float if the debit returns, never more than was settled | **Real**, on devnet |
| Bank-debit webhook listener (`adapter/scripts/settle-server.ts`) | **Real**. Driven end to end by a sandbox bank debit from Flick's open banking sandbox (see below). A `returned` webhook sends the USDC still in the vault back to the float. |
| TypeScript adapter implementing the shared OpenFi chain interface | **Real**. Passes the shared conformance suite (25 rules) on LiteSVM. |
| Credential issuance service (VC-JWT, status list) | Off-chain service; the on-chain side anchors commitments and the status-list root. Funded work. |
| Milestone Escrow, Attestation Verifier | V2, funded work |
| Router checks the allowance record | **Real**, on devnet. The router never pays an arbitrary account: `settle` pays only into the vault of a live mandate (allowance program, not revoked, not expired), and `settle_pull` pays an authorised pull only to its payee, for its exact amount, once. |
| Operator keys | Prototype uses one key as executor, credential issuer, allowance operator and router authority. Production: separate keys in KMS, router authority behind a threshold multisig, upgrade authority behind a multisig with a timelock. |
| Program initialisation | `init_*` instructions accept their first caller as admin. They were initialised immediately after deploy; before mainnet they will accept only the upgrade authority. |

## Devnet evidence

Run of 2026-11-18 (UTC) with Circle's devnet USDC. Every row is verifiable on the explorer; the three rejected steps are failed transactions whose logs carry the program's own error. Raw transactions are archived in [`evidence/`](evidence/).

| Item | Link |
|---|---|
| Identity program | [`8LeyKvcY…Q5Yo`](https://explorer.solana.com/address/8LeyKvcY9XkHYt6WePMdwc8cpRHCoXsVqkXY1QJ7Q5Yo?cluster=devnet) |
| Allowance program | [`9BNvSF8b…Cs1B`](https://explorer.solana.com/address/9BNvSF8bUEQJaBbWxBmtjRnBH1qmM47JpWWDwKM8Cs1B?cluster=devnet) |
| Router program | [`d85jMjdA…7UL`](https://explorer.solana.com/address/d85jMjdA3wUtjeD1wBuAarMMcYczSmNyWajJSxpW7UL?cluster=devnet) |
| Token: USDC (devnet) | [`4zMMC9sr…ncDU`](https://explorer.solana.com/address/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU?cluster=devnet) |
| Credential anchored: principal (bank-verified) | [7tw9mRXW…](https://explorer.solana.com/tx/7tw9mRXWAc9vZMHs5KsE6Lk1JzD1RrQ2pVNVaz8yGjXJDpXTtuPDZcMnbcn61cTn5Pe97LpricEfLH3HvV674MT?cluster=devnet) |
| Bot wallet with no credential tries to create a mandate: rejected on-chain (`IdentityRequired`, raised by the identity program via CPI) | [3PfpHuv5…](https://explorer.solana.com/tx/3PfpHuv5W5FFhjeg1b2egjhuiiBDHeHkpqcYMPAu8mSRRFpM1z14iJ4Vu8Ht3AFD7A9QQM7azScC18TBenyJyoNz?cluster=devnet) |
| Mandate created ($50/day, $10 per pull, one payee) | [2fvWrfrB…](https://explorer.solana.com/tx/2fvWrfrBwiQi87PgPMZRRjJjuBgFZ996jAK52AXgj7nFgqCxoqUikBCeJiqtY714pEF8QVAjjKuTE1yn8h62qnaH?cluster=devnet) |
| Agent session key issued | [4yMDuS5o…](https://explorer.solana.com/tx/4yMDuS5ocoXvkhUjAxDGjZoAtyL3ZT49jYqJhJXq5pAiTmaXjgV57YE3mTGrSpBLFMrVmW5jtV4pgZo74tGYDR24?cluster=devnet) |
| Sandbox bank debit cleared; router settles 10 USDC into the mandate's vault | [4UoFtizf…](https://explorer.solana.com/tx/4UoFtizfnDD4tdPpAfEdAXSfrQy97fLeN6t8YDervi3u3XGT7vSY2SWwmHPc4vBSkYV5q2cYkiFTEGWSNBo31Yk7?cluster=devnet) |
| Pull 1: $10 USDC from the vault to the merchant | [4Ecos3aE…](https://explorer.solana.com/tx/4Ecos3aE4P2Q3YgvHVQeBxoyvLwrHbucJXzcZ1AwkLzbEeoCkbT2UL3rQqicxVGDHazGRvdsTraGSxVRhzSVPQpV?cluster=devnet) |
| Pulls 2–5: $10 each, authorised for the bank side | [2](https://explorer.solana.com/tx/aBRGqPf3SbmfziLPq3yqaA8CsBpKz6Ck73jAcDgu6vDjaVu4PGU83MFR5TiHdiXXxtdH56N9kikDEYgJz2Bdoup?cluster=devnet) · [3](https://explorer.solana.com/tx/8k1guYxpdwZDgjnnjrbjH4udFmv9CmZN3Ux3yzVkALDxSRNs15y5XyL2aB41GPWoqdyaN3VFM3apmYFhzBTowqz?cluster=devnet) · [4](https://explorer.solana.com/tx/5fa8WbJEUbPsPQUe6hYJ24kXLMeE26LMHymZAbB3ezQn1GJ9VmZF7M6AezBGmf6mUcQakbe15PXYee1NDgm45Gq3?cluster=devnet) · [5](https://explorer.solana.com/tx/2vZzTqgyyuP5vWERnZCQDPUt7ttAe2NfpmWaToFGs45MaXeJsbYKuc4kieq3LNMN5tpfEZMxNSCXvokhcwXiisQJ?cluster=devnet) |
| Pull 6: $10 over the $50/day cap, rejected on-chain (`EpochCapExceeded`) | [ru4e78ea…](https://explorer.solana.com/tx/ru4e78eatxXfBa2UofTA7R4fqUkxZLFwkarfgX4sWs53bYVDVciTyqjoRvoUhBz2GNJfzBuJQX4a5L2tN65knbm?cluster=devnet) |
| Mandate revoked by the principal | [WX5Jd1DV…](https://explorer.solana.com/tx/WX5Jd1DV9RcETm2BkTYMFa5CoUkVy2XQMAFcPC5yxxDnj27a438Rf7Jf8biPXjhCYgwDLLeKxrCLGV29RV5wo7A?cluster=devnet) |
| Pull 7: $1 after revocation, rejected on-chain (`MandateRevoked`) | [5XWyygU4…](https://explorer.solana.com/tx/5XWyygU4Ngq3HsNPGrawuH81NkzmQf1ZQCcTgryLo5vuS7V1qri7y1ZBiA8FXFuZev51sSA77y9FdjnxSqu2bYFU?cluster=devnet) |

The principal, the merchant and the bot hold no SOL: OpenFi's executor pays every fee. The agent never sends a transaction; it signs pull intents with its session key.

### Sandbox bank debit to Solana settlement

Same run. In Flick's open banking sandbox the principal linked a sandbox bank account (First Example Bank, checking ••••4821) and a $10.00 one-off USD bank debit was made for the mandate (`adapter/scripts/start-debit.ts`). When it cleared, the sandbox sent a signed `paid` webhook; the listener verified the signature, read the amount and mandate from the charge, and the Settlement Router released 10 USDC into the mandate's vault. The router keys each settlement by `sha256(chargeId)`, so the same debit can never settle twice; [`evidence/README.md`](evidence/README.md) shows how to check the hash against the on-chain event.

The sandbox's bank leg ran on its deterministic mock (`live: false`); the HTTP contract, webhook payloads and signing are the same as with the live rail.

## How it works

```
principal ──create_mandate / issue_session / revoke──►  openfi_allowance ──CPI assert_human──► openfi_identity
                                                            │  Mandate PDA, SessionKey PDAs, vault (token account)
agent ──signs PullIntent (ed25519, off-chain)──► OpenFi executor
                                                            │
                         tx: [ed25519 precompile, authorize_pull | execute_pull]
                                                            │
                                     openfi_allowance checks, in order:
                                     ├─ mandate not revoked, not expired
                                     ├─ session key exists, not revoked, not expired, scoped for this kind of pull
                                     ├─ the precompile verified exactly this intent under this session key
                                     ├─ nonce current, intent not expired
                                     ├─ payee allowlisted and verified (CPI to identity)
                                     └─ per-pull, epoch, session and total caps  → else the transaction fails

bank debit clears ──signed webhook──► settle-server ──► openfi_router.settle(chargeId) ──USDC──► mandate vault
bank debit returns ─signed webhook──► settle-server ──► openfi_allowance.return_settlement ──CPI──► openfi_router.refund ──USDC──► float
authorize_pull → fiat clears ───────► openfi_router.settle_pull(ref) ──reads the allowance pull record──► USDC to that pull's payee
```

The epoch rolls inside the pull (aligned to the mandate's first epoch), so no keeper is needed. A pull record per reference makes a repeated reference fail.

### Pull intent

The agent signs 134 bytes: `OPENFI_PULL_V1 | mandate | payee | amount (u64 LE) | sha256(ref) | nonce (u64 LE) | expires_at (i64 LE)`. The executor submits it behind an ed25519 precompile instruction; the program reads that instruction through the instructions sysvar and requires its public key and message to match the session key and the intent it is executing. A valid signature for one intent cannot authorise another (tested in `adapter/test/onchain.test.ts`).

## Programs

**`openfi_identity`** ([`programs/openfi_identity/src/lib.rs`](programs/openfi_identity/src/lib.rs))

| Instruction | Auth | Purpose |
|---|---|---|
| `init_registry(issuer)` | admin | Registry and issuer key |
| `anchor_credential(subject, commitment, level, expires_at, nullifier)` | issuer | Stores the sha256 of the VC-JWT, level and expiry; no personal data. A nullifier already bound to another wallet fails. |
| `revoke_credential` | issuer | Immediate: `assert_human` fails from the next transaction |
| `rotate_status_root(root, version)` | issuer | Publishes the root of the off-chain VC status list for relying parties. The version must go up, so an older list cannot be replayed. |
| `assert_human(min_level)` | | CPI gate used by the allowance program |

Errors (6000+): IdentityRequired, DuplicateIdentity, InvalidLevel, InvalidExpiry, StaleStatusVersion.

**`openfi_allowance`** ([`programs/openfi_allowance/src/lib.rs`](programs/openfi_allowance/src/lib.rs))

| Instruction | Auth | Purpose |
|---|---|---|
| `create_mandate(args)` | principal (verified) | Mandate PDA and its vault |
| `update_mandate(args)` | principal | Changes caps, payees, expiry or required level (epoch length is fixed). Bumps the nonce, so intents signed against the old terms fail with `StaleNonce`. |
| `revoke_mandate` | principal | Kills every session key |
| `deposit(amount)` | principal | Prefund: moves tokens from the principal's account into the vault for `execute_pull` |
| `close` | principal + operator | Revokes the mandate, pays the vault balance to the principal and closes the vault. The operator co-signs only once no settlement into the vault can still be reversed. The mandate account stays as a revoked tombstone so its id, and the session keys derived from it, can never be reused. |
| `issue_session(pubkey, sub_cap, expires_at, scope)` / `revoke_session` | principal | Agent keys with their own per-epoch cap and scope: `1` = may sign for `authorize_pull`, `2` = for `execute_pull`, `3` = both. A key scoped only for bank-side pulls can never move tokens from the vault. |
| `authorize_pull(intent, session_pubkey)` | session-key signature | Spends allowance, emits `PullAuthorized`; the bank side moves fiat after this |
| `execute_pull(intent, session_pubkey)` | session-key signature | Spends allowance and transfers from the vault to the payee |
| `restore_allowance` | operator | Saga compensation when the fiat leg of an authorised pull returns. Refused once the router has paid the pull (`settle_pull`). |
| `return_settlement(amount)` | operator | Saga compensation when the bank debit that funded the vault returns: sends USDC from the vault back to the router's float through `refund`, signed by the mandate |

Errors (6000+): InvalidAmount, MandateRevoked, MandateExpired, UnknownSession, SessionRevoked, SessionExpired, BadSignature, StaleNonce, IntentExpired, PayeeNotAllowed, PerPullCapExceeded, EpochCapExceeded, SessionCapExceeded, TotalCapExceeded, InsufficientVault, TooManyPayees, InvalidMandate, NotRestorable, ScopeNotAllowed.

**`openfi_router`** ([`programs/openfi_router/src/lib.rs`](programs/openfi_router/src/lib.rs))

| Instruction | Auth | Purpose |
|---|---|---|
| `init_router(authority)` | admin | Router config and its USDC float |
| `settle(ref_hash, amount)` | settlement authority | Funds a mandate's vault after its bank debit clears. Reads the allowance program's mandate and pays only into that mandate's vault, only while it is live (not revoked, not expired, same mint). Records a `Settlement` PDA keyed by the reference, emits `Settled`. |
| `settle_pull(ref_hash)` | settlement authority | Pays an authorised pull after its fiat leg clears. Reads the allowance program's pull record and pays only if it is open (not executed from the vault, not restored), only to its payee, and exactly its amount. Records a `Settlement` for the ref, emits `PullSettled`. |
| `refund(amount)` | owner of the account that was paid | Returns USDC to the float against a `Settlement`, only from the account it paid; partial refunds add up to at most the settled amount; emits `Refunded` |

Errors (6000+): InvalidAmount, InsufficientInventory, RefundExceedsSettlement, NotAnAuthorizedPull, PullNotSettleable, WrongPayee, NotAMandateVault, MandateRevoked, MandateExpired.

Amounts are integers in the token's base units (USDC has 6 decimals: 10 USDC = `10000000`). Programs use the token interface, so classic SPL Token and Token-2022 mints both work.

## Shared interface

The adapter implements the chain-agnostic OpenFi `ChainAdapter` interface and runs the shared conformance suite, the same rules every OpenFi chain must enforce (the Stellar prototype is the other). Both come from npm: [`@openfi/chain-interface`](https://www.npmjs.com/package/@openfi/chain-interface) and [`@openfi/chain-conformance`](https://www.npmjs.com/package/@openfi/chain-conformance), pinned at `0.1.0`.

## Run the tests

Requires Rust, the [Solana CLI](https://solana.com/docs/intro/installation), Anchor 1.2 and Node 20+.

```sh
anchor build
cargo test -p openfi_allowance --lib          # epoch rollover and intent layout
cd adapter && npm install && npm test         # conformance suite + on-chain enforcement, on LiteSVM
```

`adapter/test/onchain.test.ts` checks that each key rejection is a failed transaction with the program's error in its logs, not a refusal made off-chain, including a genuine $1 signature replayed as a $9 pull. `adapter/test/update-refund.test.ts` covers mandate updates (old-nonce intents die, only the principal can update, a revoked mandate stays revoked) and refunds (partial then full, never above the settled amount, never from an account the settlement did not pay, operator only). `adapter/test/settle-vault.test.ts` covers the router's `settle` restriction (a wallet, another mandate's vault, a forged mandate, a revoked or expired mandate are all refused on-chain). `adapter/test/settle-pull.test.ts` covers the router's allowance check (only that payee, that amount, once; never for an executed, restored or unknown pull; never from a forged record; and a paid pull cannot be restored). `adapter/test/scope.test.ts` covers session scopes (a bank-pull-only key cannot move vault tokens, and the reverse). `adapter/test/status-deposit-close.test.ts` covers the status root (moves forward only, issuer only), deposits (principal only, not into a revoked mandate) and close (balance back to the principal, operator required, id never reusable).

## Run the demo on devnet

```sh
cd adapter
cp ../.env.example ../.env                    # fill in
set -a; . ../.env; set +a
npm run demo                                  # scenario with a placeholder bank debit
BANK_DEBIT=1 npm run demo                     # with a Flick sandbox bank debit (sandbox + settle-server running)
```

The demo prints an explorer link for each step and archives every transaction under `evidence/`. Rejected steps are submitted on purpose (preflight is skipped), so the rejection is recorded on the ledger.

## License

Apache-2.0
