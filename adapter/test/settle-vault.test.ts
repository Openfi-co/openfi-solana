import { randomUUID } from 'node:crypto';
import { toBaseUnits, type OnChainMandate } from '@openfi/chain-interface';
import type { Address } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { beforeAll, describe, expect, it } from 'vitest';
import { getSettleInstruction } from '../src/generated/router/index.js';
import { toChainError } from '../src/errors.js';
import { allowancePdas, identityPdas, routerPdas, sha256 } from '../src/pdas.js';
import { TxFailure } from '../src/transport.js';
import { createLiteSvmHarness } from './harness.js';

const usd = (a: string) => toBaseUnits(a, 6);

/**
 * The conformance suite checks settle's error codes. These check that the
 * router itself refuses every destination other than a live mandate's vault,
 * by sending hand-built settle instructions the adapter would never build.
 */
describe('router settle pays only into a live mandate vault', () => {
  let h: Awaited<ReturnType<typeof createLiteSvmHarness>>;
  const logs: string[][] = [];

  beforeAll(async () => {
    h = await createLiteSvmHarness();
    await h.fundRouter(usd('1000'));
    const send = h.transport.send.bind(h.transport);
    h.transport.send = async (ixs, signers) => {
      try {
        return await send(ixs, signers);
      } catch (e) {
        if (e instanceof TxFailure) logs.push(e.logs);
        throw e;
      }
    };
  });

  async function mandate() {
    const verified = async () => {
      const w = await h.newWallet();
      const hex = () => randomUUID().replaceAll('-', '').repeat(2);
      await h.adapter.anchorCredential({ subject: w.address, commitment: hex(), level: 'bank_verified', expiresAt: (await h.now()) + 86400, nullifier: hex() });
      return w;
    };
    const principal = await verified();
    const payee = await verified();
    const m: OnChainMandate = {
      mandateId: `mnd_${randomUUID()}`, principal: principal.address, token: h.adapter.token, payees: [payee.address],
      perPullCap: usd('10'), epochSeconds: 86400, epochCap: usd('50'), totalCap: usd('1500'),
      expiresAt: (await h.now()) + 86400, requiredLevel: 'bank_verified', nonce: 0,
    };
    await h.adapter.createMandate(m);
    const address = allowancePdas.mandate(m.mandateId);
    return { m, principal, address, vault: allowancePdas.vault(address) };
  }

  const settle = (mandate: Address, destination: Address, ref = `chg_${randomUUID()}`) =>
    h.transport.send(
      [
        getSettleInstruction({
          authority: h.executor,
          config: routerPdas.config(),
          mint: h.mint,
          inventory: routerPdas.inventory(),
          mandate,
          destination,
          settlement: routerPdas.settlement(ref),
          refHash: sha256(ref),
          amount: usd('10'),
        }),
      ],
      [h.executor],
    );

  async function refusedOnChain(p: Promise<unknown>, programError: string) {
    const before = logs.length;
    const err = await p.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(TxFailure);
    expect(logs.length).toBe(before + 1);
    expect(logs.at(-1)!.join('\n')).toContain(`Error Code: ${programError}`);
    return toChainError(err, null);
  }

  it('pays the vault of the mandate it names', async () => {
    const { address, vault, m } = await mandate();
    await settle(address, vault);
    expect(await h.vaultBalanceOf(m.mandateId)).toBe(usd('10'));
  });

  it('refuses a wallet, even when it names a real mandate', async () => {
    const { address, principal } = await mandate();
    const [ata] = await findAssociatedTokenPda({ owner: principal.address as Address, mint: h.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const err = await refusedOnChain(settle(address, ata), 'NotAMandateVault');
    expect((err as { code?: string }).code).toBe('UNAUTHORIZED');
    expect(await h.balanceOf(principal.address)).toBe(0n);
  });

  it('refuses another mandate’s vault', async () => {
    const a = await mandate();
    const b = await mandate();
    await refusedOnChain(settle(a.address, b.vault), 'NotAMandateVault');
  });

  it('refuses a fake mandate: an account of another program or of the wrong type', async () => {
    const { vault, principal } = await mandate();
    await refusedOnChain(settle(routerPdas.config(), vault), 'NotAMandateVault');
    await refusedOnChain(settle(identityPdas.credential(principal.address as Address), vault), 'NotAMandateVault');
    await refusedOnChain(settle(allowancePdas.config(), vault), 'NotAMandateVault');
  });

  it('refuses a revoked mandate', async () => {
    const { address, vault, m } = await mandate();
    await h.adapter.revokeMandate(m.mandateId);
    await refusedOnChain(settle(address, vault), 'MandateRevoked');
  });

  it('refuses an expired mandate', async () => {
    const { address, vault } = await mandate();
    await h.advanceTime!(86401);
    await refusedOnChain(settle(address, vault), 'MandateExpired');
  });
});
