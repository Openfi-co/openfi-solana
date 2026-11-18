import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from '@solana/kit';
import type { TxStatus } from '@openfi/chain-interface';
import { TxFailure, type SentTx, type SolanaTransport } from './transport.js';

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111' as Address;

/**
 * JSON-RPC transport for devnet and mainnet.
 *
 * Transactions are sent with preflight skipped and then confirmed, so a
 * transaction the programs reject is recorded on the ledger as a failed
 * transaction with the program's error in its logs, rather than being caught
 * by local simulation. That on-chain failure is the evidence.
 */
export class RpcTransport implements SolanaTransport {
  private readonly rpc: ReturnType<typeof createSolanaRpc>;

  constructor(
    rpcUrl: string,
    private readonly cluster: 'devnet' | 'mainnet-beta' = 'devnet',
    private readonly confirmTimeoutMs = 60_000,
  ) {
    this.rpc = createSolanaRpc(rpcUrl);
  }

  /** Public RPCs rate-limit; retry 429s and transient network errors with backoff. */
  private async call<T>(req: { send(): Promise<T> }): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await req.send();
      } catch (e) {
        const status = (e as { context?: { statusCode?: number } }).context?.statusCode;
        const transient = status === 429 || (status !== undefined && status >= 500) || (e as Error).message?.includes('fetch failed');
        if (!transient || attempt >= 8) throw e;
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
      }
    }
  }

  async send(instructions: Instruction[], signers: TransactionSigner[]): Promise<SentTx> {
    const { value: blockhash } = await this.call(this.rpc.getLatestBlockhash({ commitment: 'confirmed' }));
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signers[0]!, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(tx);
    await this.call(this.rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', skipPreflight: true, maxRetries: 5n }));
    await this.confirm(signature, blockhash.lastValidBlockHeight);

    const res = await this.fetchTransaction(signature);
    const logs = [...(res?.meta?.logMessages ?? [])];
    const err = res?.meta?.err as unknown;
    if (err) {
      const [index, inner] = (err as { InstructionError?: [number, unknown] }).InstructionError ?? [null, null];
      const code = (inner as { Custom?: number } | null)?.Custom ?? null;
      throw new TxFailure(logs, index === null ? null : Number(index), code === null ? null : Number(code), signature, JSON.stringify(err, bigintSafe));
    }
    return { signature, logs };
  }

  private async confirm(signature: Signature, lastValidBlockHeight: bigint): Promise<void> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    for (let i = 0; Date.now() < deadline; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { value } = await this.call(this.rpc.getSignatureStatuses([signature]));
      const s = value[0];
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
      if (i % 5 === 4) {
        const height = await this.call(this.rpc.getBlockHeight({ commitment: 'confirmed' }));
        if (height > lastValidBlockHeight) throw new Error(`transaction ${signature} expired before confirmation`);
      }
    }
    throw new Error(`transaction ${signature} not confirmed within ${this.confirmTimeoutMs} ms`);
  }

  async getAccount(address: Address) {
    const { value } = await this.call(this.rpc.getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' }));
    if (!value) return null;
    return { data: new Uint8Array(Buffer.from(value.data[0], 'base64')), owner: value.owner };
  }

  async now(): Promise<number> {
    const acc = await this.getAccount(CLOCK_SYSVAR);
    // Clock layout: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64.
    return Number(new DataView(acc!.data.buffer, acc!.data.byteOffset).getBigInt64(32, true));
  }

  async status(signature: string): Promise<TxStatus> {
    const { value } = await this.call(this.rpc.getSignatureStatuses([signature as Signature]));
    const s = value[0];
    if (!s) return 'pending';
    if (s.err) return 'failed';
    return s.confirmationStatus === 'finalized' ? 'finalized' : s.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending';
  }

  explorerUrl(signature: string): string {
    return `https://explorer.solana.com/tx/${signature}${this.cluster === 'devnet' ? '?cluster=devnet' : ''}`;
  }

  /** Raw confirmed transaction, for archiving evidence. */
  rawTransaction(signature: string): Promise<unknown> {
    return this.fetchTransaction(signature as Signature);
  }

  /** getTransaction can briefly return null right after confirmation; retry until it appears. */
  private async fetchTransaction(signature: Signature) {
    for (let i = 0; i < 10; i++) {
      const res = await this.call(this.rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }));
      if (res) return res;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`transaction ${signature} confirmed but not retrievable`);
  }
}

function bigintSafe(_k: string, v: unknown) {
  return typeof v === 'bigint' ? v.toString() : v;
}
