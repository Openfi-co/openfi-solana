import { CHAIN_ERROR_CODES, ChainError, type ChainErrorCode } from '@openfi/chain-interface';
import { TxFailure } from './transport.js';

/**
 * Program error names that do not translate 1:1 to a shared code. Every other
 * allowance error name (EpochCapExceeded, MandateRevoked, ...) is the shared
 * code in PascalCase and maps by name.
 */
const SPECIAL: Record<string, ChainErrorCode> = {
  InvalidLevel: 'INVALID_AMOUNT',
  InvalidExpiry: 'INVALID_AMOUNT',
  InvalidMandate: 'INVALID_AMOUNT',
  TooManyPayees: 'INVALID_AMOUNT',
  NotRestorable: 'INVALID_AMOUNT',
  InsufficientInventory: 'INSUFFICIENT_VAULT',
  RefundExceedsSettlement: 'INVALID_AMOUNT',
};

/** Anchor framework constraint errors (has_one, seeds, signer, ...). */
const ANCHOR_CONSTRAINT = { min: 2000, max: 2999 };

const isShared = (c: string): c is ChainErrorCode => (CHAIN_ERROR_CODES as readonly string[]).includes(c);

/**
 * Turn a failed transaction into a ChainError.
 *
 * Anchor logs `Error Code: <Name>. Error Number: <n>` from the program that
 * raised it, including one reached by CPI (an identity check inside a pull),
 * so the name in the logs is more precise than the custom code, which only
 * says which instruction failed.
 *
 * `precompileIndex` is the position of the ed25519 instruction, if any: a
 * failure there means the session key did not sign this intent.
 */
export function toChainError(e: unknown, precompileIndex: number | null, explorer?: (sig: string) => string): unknown {
  if (!(e instanceof TxFailure)) return e;
  const url = e.signature && explorer ? explorer(e.signature) : undefined;
  const fail = (code: ChainErrorCode, msg?: string) => new ChainError(code, msg ?? code, e.signature, url);

  if (precompileIndex !== null && e.instructionIndex === precompileIndex) return fail('BAD_SIGNATURE');

  const names = [...e.logs.join('\n').matchAll(/Error Code: (\w+)\. Error Number: (\d+)/g)];
  const last = names.at(-1);
  if (last) {
    const [, name, num] = last as unknown as [string, string, string];
    const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (SPECIAL[name]) return fail(SPECIAL[name], name);
    if (isShared(snake)) return fail(snake, name);
    const n = Number(num);
    if (n >= ANCHOR_CONSTRAINT.min && n <= ANCHOR_CONSTRAINT.max) return fail('UNAUTHORIZED', name);
  }
  return e;
}
