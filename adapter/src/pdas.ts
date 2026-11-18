import { createHash } from 'node:crypto';
import { getAddressDecoder, getAddressEncoder, isOffCurveAddress, type Address } from '@solana/kit';
import { OPENFI_ALLOWANCE_PROGRAM_ADDRESS } from './generated/allowance/index.js';
import { OPENFI_IDENTITY_PROGRAM_ADDRESS } from './generated/identity/index.js';
import { OPENFI_ROUTER_PROGRAM_ADDRESS } from './generated/router/index.js';

const enc = new TextEncoder();
const addrEnc = getAddressEncoder();
const addrDec = getAddressDecoder();
const PDA_MARKER = enc.encode('ProgramDerivedAddress');

/** Off-chain ids (mandate ids, refs) become 32-byte seeds by sha256. */
export const sha256 = (s: string): Uint8Array => new Uint8Array(createHash('sha256').update(s).digest());

const bytes = (a: Address) => addrEnc.encode(a) as Uint8Array;

/**
 * Synchronous `find_program_address`: the runtime's bump search, with node's
 * sha256. Kit's version is async (WebCrypto); the shared interface needs
 * `encodeIntent` to be synchronous, and the mandate address is part of it.
 */
export function findPda(program: Address, ...seeds: (string | Uint8Array)[]): Address {
  const raw = seeds.map((s) => (typeof s === 'string' ? enc.encode(s) : s));
  const programBytes = bytes(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of raw) h.update(s);
    h.update(Uint8Array.of(bump)).update(programBytes).update(PDA_MARKER);
    const candidate = addrDec.decode(new Uint8Array(h.digest()));
    if (isOffCurveAddress(candidate)) return candidate;
  }
  throw new Error('no viable bump seed');
}

export const identityPdas = {
  registry: () => findPda(OPENFI_IDENTITY_PROGRAM_ADDRESS, 'registry'),
  credential: (subject: Address) => findPda(OPENFI_IDENTITY_PROGRAM_ADDRESS, 'credential', bytes(subject)),
  nullifier: (nullifier: Uint8Array) => findPda(OPENFI_IDENTITY_PROGRAM_ADDRESS, 'nullifier', nullifier),
  status: () => findPda(OPENFI_IDENTITY_PROGRAM_ADDRESS, 'status'),
};

export const allowancePdas = {
  config: () => findPda(OPENFI_ALLOWANCE_PROGRAM_ADDRESS, 'config'),
  mandate: (mandateId: string) => findPda(OPENFI_ALLOWANCE_PROGRAM_ADDRESS, 'mandate', sha256(mandateId)),
  vault: (mandate: Address) => findPda(OPENFI_ALLOWANCE_PROGRAM_ADDRESS, 'vault', bytes(mandate)),
  session: (mandate: Address, sessionKey: Address) =>
    findPda(OPENFI_ALLOWANCE_PROGRAM_ADDRESS, 'session', bytes(mandate), bytes(sessionKey)),
  pull: (mandate: Address, ref: string) => findPda(OPENFI_ALLOWANCE_PROGRAM_ADDRESS, 'pull', bytes(mandate), sha256(ref)),
};

export const routerPdas = {
  config: () => findPda(OPENFI_ROUTER_PROGRAM_ADDRESS, 'router'),
  inventory: () => findPda(OPENFI_ROUTER_PROGRAM_ADDRESS, 'inventory'),
  settlement: (ref: string) => findPda(OPENFI_ROUTER_PROGRAM_ADDRESS, 'settlement', sha256(ref)),
};
