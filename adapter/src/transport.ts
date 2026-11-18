import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import type { TxStatus } from '@openfi/chain-interface';

export interface SentTx {
  signature: string;
  logs: string[];
}

/** A transaction the cluster rejected. Carries what error mapping needs. */
export class TxFailure extends Error {
  constructor(
    readonly logs: string[],
    /** Index of the failing instruction in the transaction, when known. */
    readonly instructionIndex: number | null,
    /** Custom program error code, when the failure was one. */
    readonly customCode: number | null,
    readonly signature?: string,
    message?: string,
  ) {
    super(message ?? 'transaction failed');
    this.name = 'TxFailure';
  }
}

/**
 * Everything the adapter needs from a cluster. Implemented over LiteSVM (tests,
 * local) and over JSON-RPC (devnet, mainnet).
 */
export interface SolanaTransport {
  /** `signers[0]` pays fees; other signers come from the instructions. Throws `TxFailure` on failure. */
  send(instructions: Instruction[], signers: TransactionSigner[]): Promise<SentTx>;
  getAccount(address: Address): Promise<{ data: Uint8Array; owner: Address } | null>;
  /** Cluster clock, unix seconds. */
  now(): Promise<number>;
  status(signature: string): Promise<TxStatus>;
  explorerUrl?(signature: string): string;
}
