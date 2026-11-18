import {
  getAddressDecoder,
  getAddressEncoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  ChainError,
  type ChainAdapter,
  type IdentityLevel,
  type OnChainMandate,
  type PullIntent,
  type SignedPullIntent,
  type TxResult,
  type TxStatus,
} from '@openfi/chain-interface';
import {
  getAuthorizePullInstruction,
  getCloseInstruction,
  getCreateMandateInstruction,
  getDepositInstruction,
  getExecutePullInstruction,
  getIssueSessionInstruction,
  getMandateDecoder,
  getPullRecordDecoder,
  getRestoreAllowanceInstruction,
  getRevokeMandateInstruction,
  getReturnSettlementInstruction,
  getRevokeSessionInstruction,
  getUpdateMandateInstruction,
  type Mandate,
} from './generated/allowance/index.js';
import {
  getAnchorCredentialInstruction,
  getCredentialAnchorDecoder,
  getRevokeCredentialInstruction,
  getRotateStatusRootInstruction,
  getStatusListDecoder,
} from './generated/identity/index.js';
import { getSettleInstruction, getSettlementDecoder, getSettlePullInstruction, OPENFI_ROUTER_PROGRAM_ADDRESS } from './generated/router/index.js';
import { toChainError } from './errors.js';
import { allowancePdas, identityPdas, routerPdas, sha256 } from './pdas.js';
import type { SolanaTransport } from './transport.js';

export const ED25519_PROGRAM_ADDRESS = 'Ed25519SigVerify111111111111111111111111111' as Address;

/** Fields of a live mandate the principal can change. Omitted fields stay as they are. */
export interface MandateChanges {
  payees?: string[];
  perPullCap?: bigint;
  epochCap?: bigint;
  totalCap?: bigint;
  expiresAt?: number;
  requiredLevel?: IdentityLevel;
}

/** Solana mainnet-beta and devnet CAIP-2 ids. */
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const LEVEL: Record<IdentityLevel, number> = { none: 0, bank_verified: 1 };

/**
 * What a session key may sign for. `authorize`: bank-side pulls
 * (`authorizePull`, no tokens move). `execute`: pulls paid from the mandate's
 * vault (`executePull`).
 */
export type SessionScope = 'authorize' | 'execute';
const SCOPE_BIT: Record<SessionScope, number> = { authorize: 1, execute: 2 };
const INTENT_DOMAIN = new TextEncoder().encode('OPENFI_PULL_V1');

export interface SolanaAdapterOptions {
  transport: SolanaTransport;
  /** OpenFi's key: pays fees, submits intents, and is the identity issuer, router authority and allowance operator. */
  executor: TransactionSigner;
  /** Settlement token mint (USDC). */
  mint: Address;
  decimals?: number;
  chainId?: string;
  tokenProgram?: Address;
  /**
   * Signer for a principal's wallet, for the calls a principal must authorise
   * (create/revoke mandate, issue/revoke session). In production this is the
   * principal's wallet signing a transaction OpenFi built.
   */
  signerFor: (address: Address) => TransactionSigner | undefined;
}

/**
 * ChainAdapter over the OpenFi Solana programs. Every rule that protects funds
 * is enforced on-chain; this class builds and submits transactions, reads
 * accounts, and maps failures to the shared error codes. The only checks made
 * off-chain are the ones the shared contract defines as "no-op" or "unknown":
 * a repeated ref returns `duplicate` without sending, and calls on a mandate
 * or session that does not exist fail with UNKNOWN_*.
 */
export class SolanaChainAdapter implements ChainAdapter {
  readonly chainId: string;
  readonly decimals: number;
  readonly token: string;
  private readonly t: SolanaTransport;
  private readonly executor: TransactionSigner;
  private readonly mint: Address;
  private readonly tokenProgram: Address;
  private readonly signerFor: SolanaAdapterOptions['signerFor'];

  constructor(o: SolanaAdapterOptions) {
    this.t = o.transport;
    this.executor = o.executor;
    this.mint = o.mint;
    this.token = o.mint;
    this.decimals = o.decimals ?? 6;
    this.chainId = o.chainId ?? SOLANA_DEVNET;
    this.tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
    this.signerFor = o.signerFor;
  }

  resolveAddress(did: string): string {
    const prefix = `did:pkh:${this.chainId}:`;
    if (!did.startsWith(prefix)) throw new ChainError('INVALID_ADDRESS', `not a ${this.chainId} DID: ${did}`);
    return did.slice(prefix.length);
  }

  // ---------------------------------------------------------------- identity

  async anchorCredential(i: { subject: string; commitment: string; level: IdentityLevel; expiresAt: number; nullifier: string }): Promise<TxResult> {
    const subject = i.subject as Address;
    const nullifier = hex32(i.nullifier);
    return this.submit([
      getAnchorCredentialInstruction({
        issuer: this.executor,
        registry: identityPdas.registry(),
        credential: identityPdas.credential(subject),
        nullifierRecord: identityPdas.nullifier(nullifier),
        subject,
        commitment: hex32(i.commitment),
        level: LEVEL[i.level],
        expiresAt: i.expiresAt,
        nullifier,
      }),
    ]);
  }

  async revokeCredential(subject: string): Promise<TxResult> {
    return this.submit([
      getRevokeCredentialInstruction({
        issuer: this.executor,
        registry: identityPdas.registry(),
        credential: identityPdas.credential(subject as Address),
      }),
    ]);
  }

  /**
   * Publish a new root of the issuer's off-chain credential status list.
   * `version` must be higher than the current one. Solana-specific for now.
   */
  async rotateStatusRoot(i: { root: string; version: number }): Promise<TxResult> {
    return this.submit([
      getRotateStatusRootInstruction({
        issuer: this.executor,
        registry: identityPdas.registry(),
        status: identityPdas.status(),
        root: hex32(i.root),
        version: i.version,
      }),
    ]);
  }

  /** The current status-list root (hex), or null if none has been published. */
  async statusRoot(): Promise<{ root: string; version: number; updatedAt: number } | null> {
    const acc = await this.t.getAccount(identityPdas.status());
    if (!acc) return null;
    const s = getStatusListDecoder().decode(acc.data);
    return { root: Buffer.from(s.root).toString('hex'), version: Number(s.version), updatedAt: Number(s.updatedAt) };
  }

  async isVerified(subject: string, minLevel: IdentityLevel): Promise<boolean> {
    if (minLevel === 'none') return true;
    const acc = await this.t.getAccount(identityPdas.credential(subject as Address));
    if (!acc) return false;
    const c = getCredentialAnchorDecoder().decode(acc.data);
    return !c.revoked && Number(c.expiresAt) > (await this.t.now()) && c.level >= LEVEL[minLevel];
  }

  // ---------------------------------------------------------------- mandates

  async createMandate(m: OnChainMandate): Promise<TxResult> {
    const principal = this.principal(m.principal);
    const mandate = allowancePdas.mandate(m.mandateId);
    return this.submit([
      getCreateMandateInstruction({
        payer: this.executor,
        principal,
        principalCredential: identityPdas.credential(principal.address),
        mandate,
        mint: this.mint,
        vault: allowancePdas.vault(mandate),
        tokenProgram: this.tokenProgram,
        id: sha256(m.mandateId),
        payees: m.payees.map((p) => p as Address),
        perPullCap: m.perPullCap,
        epochSeconds: m.epochSeconds,
        epochCap: m.epochCap,
        totalCap: m.totalCap,
        expiresAt: m.expiresAt,
        requiredLevel: LEVEL[m.requiredLevel],
        nonce: m.nonce,
      }),
    ]);
  }

  /**
   * Change a live mandate. Principal-signed. The mandate's nonce goes up by
   * one, so intents signed against the old terms fail with STALE_NONCE; the
   * new nonce is returned for the agent's next intent. Solana-specific for now
   * (not yet in the shared ChainAdapter interface).
   */
  async updateMandate(mandateId: string, c: MandateChanges): Promise<TxResult & { nonce: number }> {
    const { address: mandate, data } = await this.loadMandate(mandateId);
    const opt = <T>(v: T | undefined) => (v === undefined ? null : v);
    const r = await this.submit([
      getUpdateMandateInstruction({
        principal: this.principal(data.principal),
        mandate,
        payees: opt(c.payees?.map((p) => p as Address)),
        perPullCap: opt(c.perPullCap),
        epochCap: opt(c.epochCap),
        totalCap: opt(c.totalCap),
        expiresAt: opt(c.expiresAt),
        requiredLevel: opt(c.requiredLevel === undefined ? undefined : LEVEL[c.requiredLevel]),
      }),
    ]);
    return { ...r, nonce: Number(data.nonce) + 1 };
  }

  /** Current nonce of a mandate: the value an agent's next intent must carry. */
  async mandateNonce(mandateId: string): Promise<number> {
    return Number((await this.loadMandate(mandateId)).data.nonce);
  }

  async revokeMandate(mandateId: string): Promise<TxResult> {
    const { address: mandate, data } = await this.loadMandate(mandateId);
    return this.submit([getRevokeMandateInstruction({ principal: this.principal(data.principal), mandate })]);
  }

  /** Prefund: the principal moves `amount` from their own token account into the mandate's vault. Solana-specific for now. */
  async deposit(i: { mandateId: string; amount: bigint }): Promise<TxResult> {
    if (i.amount <= 0n) throw new ChainError('INVALID_AMOUNT');
    const { address: mandate, data } = await this.loadMandate(i.mandateId);
    return this.submit([
      getDepositInstruction({
        principal: this.principal(data.principal),
        mandate,
        principalToken: await this.tokenAccount(data.principal),
        vault: allowancePdas.vault(mandate),
        mint: this.mint,
        tokenProgram: this.tokenProgram,
        amount: i.amount,
      }),
    ]);
  }

  /**
   * End a mandate: revoke it, pay the vault balance to the principal, close
   * the vault. Signed by the principal and by OpenFi as operator, which must
   * only co-sign once no settlement into the vault can still be reversed.
   * Solana-specific for now.
   */
  async closeMandate(mandateId: string): Promise<TxResult> {
    const { address: mandate, data } = await this.loadMandate(mandateId);
    const vault = allowancePdas.vault(mandate);
    if (!(await this.t.getAccount(vault))) return { txId: null, status: 'duplicate' };
    return this.submit([
      getCloseInstruction({
        principal: this.principal(data.principal),
        operator: this.executor,
        config: allowancePdas.config(),
        mandate,
        principalToken: await this.tokenAccount(data.principal),
        vault,
        mint: this.mint,
        tokenProgram: this.tokenProgram,
      }),
    ]);
  }

  /** `scope` defaults to both kinds of pull, as the shared interface assumes. */
  async issueSession(i: { mandateId: string; sessionPubkey: string; subCap: bigint; expiresAt: number; scope?: SessionScope[] }): Promise<TxResult> {
    const { address: mandate, data } = await this.loadMandate(i.mandateId);
    const pubkey = hexToAddress(i.sessionPubkey);
    const scope = (i.scope ?? ['authorize', 'execute']).reduce((bits, s) => bits | SCOPE_BIT[s], 0);
    return this.submit([
      getIssueSessionInstruction({
        payer: this.executor,
        principal: this.principal(data.principal),
        mandate,
        session: allowancePdas.session(mandate, pubkey),
        pubkey,
        subCap: i.subCap,
        expiresAt: i.expiresAt,
        scope,
      }),
    ]);
  }

  async revokeSession(i: { mandateId: string; sessionPubkey: string }): Promise<TxResult> {
    const { address: mandate, data } = await this.loadMandate(i.mandateId);
    const session = allowancePdas.session(mandate, hexToAddress(i.sessionPubkey));
    if (!(await this.t.getAccount(session))) throw new ChainError('UNKNOWN_SESSION');
    return this.submit([getRevokeSessionInstruction({ principal: this.principal(data.principal), mandate, session })]);
  }

  async remaining(mandateId: string): Promise<{ epoch: bigint; total: bigint; epochResetsAt: number }> {
    const { data: m } = await this.loadMandate(mandateId);
    const now = BigInt(await this.t.now());
    const rolled = now - m.epochStart >= m.epochSeconds;
    const epochStart = rolled ? m.epochStart + ((now - m.epochStart) / m.epochSeconds) * m.epochSeconds : m.epochStart;
    const spentEpoch = rolled ? 0n : m.spentEpoch;
    const total = m.totalCap - m.spentTotal;
    const epoch = m.epochCap - spentEpoch;
    return { epoch: epoch < total ? epoch : total, total, epochResetsAt: Number(epochStart + m.epochSeconds) };
  }

  // ---------------------------------------------------------------- pulls

  /** `OPENFI_PULL_V1 | mandate | payee | amount u64 LE | sha256(ref) | nonce u64 LE | expiresAt i64 LE`. */
  encodeIntent(i: PullIntent): Uint8Array {
    return intentMessage(allowancePdas.mandate(i.mandateId), i);
  }

  authorizePull(input: SignedPullIntent): Promise<TxResult> {
    return this.pull(input, false);
  }

  executePull(input: SignedPullIntent): Promise<TxResult> {
    return this.pull(input, true);
  }

  async restoreAllowance(i: { mandateId: string; ref: string }): Promise<TxResult> {
    const mandate = allowancePdas.mandate(i.mandateId);
    const pullAddr = allowancePdas.pull(mandate, i.ref);
    const acc = await this.t.getAccount(pullAddr);
    if (!acc) return { txId: null, status: 'duplicate' };
    const pull = getPullRecordDecoder().decode(acc.data);
    if (pull.restored) return { txId: null, status: 'duplicate' };
    return this.submit([
      getRestoreAllowanceInstruction({
        operator: this.executor,
        config: allowancePdas.config(),
        mandate,
        pull: pullAddr,
        session: allowancePdas.session(mandate, pull.session),
        settlement: routerPdas.settlement(i.ref),
      }),
    ]);
  }

  // ---------------------------------------------------------------- settlement

  /** Fund a mandate's vault after its bank debit clears. The router refuses any other destination. */
  async settle(i: { ref: string; mandateId: string; amount: bigint }): Promise<TxResult> {
    if (i.amount <= 0n) throw new ChainError('INVALID_AMOUNT');
    const settlement = routerPdas.settlement(i.ref);
    if (await this.t.getAccount(settlement)) return { txId: null, status: 'duplicate' };
    const { address: mandate } = await this.loadMandate(i.mandateId);
    return this.submit([
      getSettleInstruction({
        authority: this.executor,
        config: routerPdas.config(),
        mint: this.mint,
        inventory: routerPdas.inventory(),
        mandate,
        destination: allowancePdas.vault(mandate),
        settlement,
        tokenProgram: this.tokenProgram,
        refHash: sha256(i.ref),
        amount: i.amount,
      }),
    ]);
  }

  /**
   * Router `settle_pull`: pay an authorised pull to its payee once the fiat
   * leg has cleared. The router reads the allowance program's pull record and
   * pays only that payee, exactly that amount, once; an executed or restored
   * pull is refused on-chain. Solana-specific for now.
   */
  async settlePull(i: { mandateId: string; ref: string }): Promise<TxResult> {
    const mandate = allowancePdas.mandate(i.mandateId);
    const pullAddr = allowancePdas.pull(mandate, i.ref);
    const settlement = routerPdas.settlement(i.ref);
    if (await this.t.getAccount(settlement)) return { txId: null, status: 'duplicate' };
    const acc = await this.t.getAccount(pullAddr);
    if (!acc) throw new ChainError('UNAUTHORIZED', `no authorised pull for ref ${i.ref}`);
    const pull = getPullRecordDecoder().decode(acc.data);
    return this.submit([
      getSettlePullInstruction({
        authority: this.executor,
        config: routerPdas.config(),
        mint: this.mint,
        inventory: routerPdas.inventory(),
        pull: pullAddr,
        destination: await this.tokenAccount(pull.payee),
        settlement,
        tokenProgram: this.tokenProgram,
        refHash: sha256(i.ref),
      }),
    ]);
  }

  /**
   * Saga compensation: the bank debit behind settlement `ref` was returned, so
   * send `amount` from the mandate's vault back to the router's inventory.
   * Operator-signed. The router refuses a total above what `ref` settled, or
   * from any account other than the one it paid. Solana-specific for now.
   */
  async returnSettlement(i: { mandateId: string; ref: string; amount: bigint }): Promise<TxResult> {
    if (i.amount <= 0n) throw new ChainError('INVALID_AMOUNT');
    const { address: mandate } = await this.loadMandate(i.mandateId);
    const settlement = routerPdas.settlement(i.ref);
    if (!(await this.t.getAccount(settlement))) throw new ChainError('INVALID_AMOUNT', `nothing settled for ref ${i.ref}`);
    return this.submit([
      getReturnSettlementInstruction({
        operator: this.executor,
        config: allowancePdas.config(),
        mandate,
        vault: allowancePdas.vault(mandate),
        mint: this.mint,
        routerConfig: routerPdas.config(),
        routerInventory: routerPdas.inventory(),
        settlement,
        routerProgram: OPENFI_ROUTER_PROGRAM_ADDRESS,
        tokenProgram: this.tokenProgram,
        amount: i.amount,
      }),
    ]);
  }

  /** What a settlement paid, and how much has been refunded against it. Null if `ref` never settled. */
  async settlement(ref: string): Promise<{ destination: string; amount: bigint; refunded: bigint } | null> {
    const acc = await this.t.getAccount(routerPdas.settlement(ref));
    if (!acc) return null;
    const s = getSettlementDecoder().decode(acc.data);
    return { destination: s.destination, amount: s.amount, refunded: s.refunded };
  }

  getStatus(txId: string): Promise<TxStatus> {
    return this.t.status(txId);
  }

  // ---------------------------------------------------------------- internals

  private async pull({ intent, sessionPubkey, signature }: SignedPullIntent, transfer: boolean): Promise<TxResult> {
    if (intent.amount < 0n) throw new ChainError('INVALID_AMOUNT');
    const { address: mandate } = await this.loadMandate(intent.mandateId);
    const pull = allowancePdas.pull(mandate, intent.ref);
    if (await this.t.getAccount(pull)) return { txId: null, status: 'duplicate' };

    const sessionKey = hexToAddress(sessionPubkey);
    const payee = intent.payee as Address;
    const message = intentMessage(mandate, intent);
    const common = {
      executor: this.executor,
      mandate,
      session: allowancePdas.session(mandate, sessionKey),
      pull,
      payee,
      payeeCredential: identityPdas.credential(payee),
      intent: {
        payee,
        amount: intent.amount,
        refHash: sha256(intent.ref),
        nonce: intent.nonce,
        expiresAt: intent.expiresAt,
      },
      sessionPubkey: sessionKey,
    };
    const ix = transfer
      ? getExecutePullInstruction({
          ...common,
          payeeToken: await this.tokenAccount(payee),
          vault: allowancePdas.vault(mandate),
          mint: this.mint,
          tokenProgram: this.tokenProgram,
        })
      : getAuthorizePullInstruction(common);
    // The ed25519 precompile sits right before the pull; the program reads it
    // through the instructions sysvar.
    return this.submit([ed25519Instruction(hexBytes(sessionPubkey, 32), hexBytes(signature, 64), message), ix], 0);
  }

  private async submit(instructions: Instruction[], precompileIndex: number | null = null): Promise<TxResult> {
    try {
      const { signature } = await this.t.send(instructions, [this.executor]);
      return { txId: signature, status: 'submitted', explorerUrl: this.t.explorerUrl?.(signature) };
    } catch (e) {
      throw toChainError(e, precompileIndex, this.t.explorerUrl?.bind(this.t));
    }
  }

  private async loadMandate(mandateId: string): Promise<{ address: Address; data: Mandate }> {
    const address = allowancePdas.mandate(mandateId);
    const acc = await this.t.getAccount(address);
    if (!acc) throw new ChainError('UNKNOWN_MANDATE');
    return { address, data: getMandateDecoder().decode(acc.data) };
  }

  private principal(address: string): TransactionSigner {
    const s = this.signerFor(address as Address);
    if (!s) throw new ChainError('UNAUTHORIZED', `no signer for principal ${address}`);
    return s;
  }

  /**
   * Where to pay `owner`: the address itself if it is already a token account
   * for this mint (a mandate vault), else the wallet's associated token
   * account. PAYEE_NOT_READY if neither exists yet.
   */
  private async tokenAccount(owner: Address): Promise<Address> {
    const direct = await this.t.getAccount(owner);
    if (direct && direct.owner === this.tokenProgram && direct.data.length >= 165) {
      const mint = getAddressDecoder().decode(direct.data.subarray(0, 32));
      if (mint === this.mint) return owner;
    }
    const [ata] = await findAssociatedTokenPda({ owner, mint: this.mint, tokenProgram: this.tokenProgram });
    if (!(await this.t.getAccount(ata))) throw new ChainError('PAYEE_NOT_READY', `${owner} has no token account for ${this.mint}`);
    return ata;
  }
}

// ------------------------------------------------------------------ encoding

const addrEnc = getAddressEncoder();
const addrDec = getAddressDecoder();

function intentMessage(mandate: Address, i: PullIntent): Uint8Array {
  const out = new Uint8Array(134);
  const v = new DataView(out.buffer);
  out.set(INTENT_DOMAIN, 0);
  out.set(addrEnc.encode(mandate) as Uint8Array, 14);
  out.set(addrEnc.encode(i.payee as Address) as Uint8Array, 46);
  v.setBigUint64(78, i.amount, true);
  out.set(sha256(i.ref), 86);
  v.setBigUint64(118, BigInt(i.nonce), true);
  v.setBigInt64(126, BigInt(i.expiresAt), true);
  return out;
}

/**
 * Ed25519 precompile instruction carrying one signature, with the public key,
 * signature and message all inside its own data (instruction index 0xFFFF).
 */
export function ed25519Instruction(pubkey: Uint8Array, signature: Uint8Array, message: Uint8Array): Instruction {
  const HEADER = 16;
  const pkOff = HEADER;
  const sigOff = pkOff + 32;
  const msgOff = sigOff + 64;
  const data = new Uint8Array(msgOff + message.length);
  const v = new DataView(data.buffer);
  data[0] = 1; // one signature
  v.setUint16(2, sigOff, true);
  v.setUint16(4, 0xffff, true);
  v.setUint16(6, pkOff, true);
  v.setUint16(8, 0xffff, true);
  v.setUint16(10, msgOff, true);
  v.setUint16(12, message.length, true);
  v.setUint16(14, 0xffff, true);
  data.set(pubkey, pkOff);
  data.set(signature, sigOff);
  data.set(message, msgOff);
  return { programAddress: ED25519_PROGRAM_ADDRESS, accounts: [], data };
}

function hexBytes(hex: string, len: number): Uint8Array {
  if (!new RegExp(`^[0-9a-fA-F]{${len * 2}}$`).test(hex)) throw new ChainError('INVALID_ADDRESS', `expected ${len} bytes of hex`);
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

const hex32 = (hex: string) => hexBytes(hex, 32);
const hexToAddress = (hex: string) => addrDec.decode(hexBytes(hex, 32));
