import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { TxFailure, type SentTx, type SolanaTransport } from './transport.js';

/** In-process cluster for tests and local runs. Supports warping the clock. */
export class LiteSvmTransport implements SolanaTransport {
  constructor(readonly svm: LiteSVM) {}

  async send(instructions: Instruction[], signers: TransactionSigner[]): Promise<SentTx> {
    // A fresh blockhash per transaction, so two identical transactions are never deduplicated.
    this.svm.expireBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signers[0]!, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    // Other signers (a principal authorising a mandate) travel in the
    // instructions' account metas; Kit collects them from there.
    const tx = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(tx);
    const res = this.svm.sendTransaction(tx);
    if ('err' in res) {
      const err = res.err() as { index?: number; err?: () => unknown };
      const inner = typeof err.err === 'function' ? (err.err() as { code?: number }) : undefined;
      throw new TxFailure(
        res.meta().logs(),
        typeof err.index === 'number' ? err.index : null,
        typeof inner?.code === 'number' ? inner.code : null,
        signature,
        res.toString(),
      );
    }
    return { signature, logs: res.logs() };
  }

  async getAccount(address: Address) {
    const a = this.svm.getAccount(address);
    return a.exists ? { data: new Uint8Array(a.data), owner: a.programAddress } : null;
  }

  async now(): Promise<number> {
    return Number(this.svm.getClock().unixTimestamp);
  }

  async status() {
    return 'finalized' as const;
  }

  advanceTime(seconds: number): void {
    const clock = this.svm.getClock();
    clock.unixTimestamp = clock.unixTimestamp + BigInt(seconds);
    this.svm.setClock(clock);
  }
}
