import { getProgramDerivedAddress, getAddressEncoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { OPENFI_ALLOWANCE_PROGRAM_ADDRESS } from '../src/generated/allowance/index.js';
import { allowancePdas, sha256 } from '../src/pdas.js';

describe('synchronous PDA derivation', () => {
  it('matches Kit for mandate, vault and pull addresses', async () => {
    for (const id of ['mnd_1', 'mnd_2', 'x'.repeat(200)]) {
      const [kitMandate] = await getProgramDerivedAddress({
        programAddress: OPENFI_ALLOWANCE_PROGRAM_ADDRESS,
        seeds: [new TextEncoder().encode('mandate'), sha256(id)],
      });
      const mandate = allowancePdas.mandate(id);
      expect(mandate).toBe(kitMandate);
      const [kitPull] = await getProgramDerivedAddress({
        programAddress: OPENFI_ALLOWANCE_PROGRAM_ADDRESS,
        seeds: [new TextEncoder().encode('pull'), getAddressEncoder().encode(mandate), sha256('ref-1')],
      });
      expect(allowancePdas.pull(mandate, 'ref-1')).toBe(kitPull);
    }
  });
});
