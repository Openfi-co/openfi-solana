import { randomUUID } from 'node:crypto';
import { newSessionKey } from '@openfi/chain-conformance';
import { ChainError, toBaseUnits, type OnChainMandate, type PullIntent } from '@openfi/chain-interface';
import type { Address } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { beforeAll, describe, expect, it } from 'vitest';
import { getSettlePullInstruction } from '../src/generated/router/index.js';
import { toChainError } from '../src/errors.js';
import { allowancePdas, routerPdas, sha256 } from '../src/pdas.js';
import { TxFailure } from '../src/transport.js';
import { createLiteSvmHarness } from './harness.js';

const usd = (a: string) => toBaseUnits(a, 6);

/**
 * Router `settle_pull` pays an authorised pull only as the allowance program
 * recorded it. Every refusal here must come from a program, on-chain.
 */
describe('router settle_pull checks the allowance record', () => {
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

  async function verified() {
    const w = await h.newWallet();
    const hex = () => randomUUID().replaceAll('-', '').repeat(2);
    await h.adapter.anchorCredential({ subject: w.address, commitment: hex(), level: 'bank_verified', expiresAt: (await h.now()) + 86400, nullifier: hex() });
    return w;
  }

  async function mandate() {
    const principal = await verified();
    const payee = await verified();
    const m: OnChainMandate = {
      mandateId: `mnd_${randomUUID()}`, principal: principal.address, token: h.adapter.token, payees: [payee.address],
      perPullCap: usd('10'), epochSeconds: 86400, epochCap: usd('50'), totalCap: usd('1500'),
      expiresAt: (await h.now()) + 86400, requiredLevel: 'bank_verified', nonce: 0,
    };
    await h.adapter.createMandate(m);
    await h.fundVault(m.mandateId, usd('50'));
    const key = newSessionKey();
    await h.adapter.issueSession({ mandateId: m.mandateId, sessionPubkey: key.pubkey, subCap: usd('50'), expiresAt: m.expiresAt });
    const pull = async (amount: string, execute = false) => {
      const intent: PullIntent = { mandateId: m.mandateId, payee: payee.address, amount: usd(amount), ref: `pull_${randomUUID()}`, nonce: 0, expiresAt: (await h.now()) + 300 };
      const signed = { intent, sessionPubkey: key.pubkey, signature: key.sign(h.adapter.encodeIntent(intent)) };
      await (execute ? h.adapter.executePull(signed) : h.adapter.authorizePull(signed));
      return intent.ref;
    };
    return { m, payee, pull };
  }

  async function refusedOnChain(p: Promise<unknown>, code: string, programError: string) {
    const before = logs.length;
    const err = await p.then(() => null, (e) => e);
    const c = err instanceof ChainError ? err.code : (toChainError(err, null) as ChainError).code;
    expect(c).toBe(code);
    expect(logs.length).toBe(before + 1);
    expect(logs.at(-1)!.join('\n')).toContain(`Error Code: ${programError}`);
  }

  const ata = async (owner: string) => (await findAssociatedTokenPda({ owner: owner as Address, mint: h.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const settlePullIx = async (ref: string, pullAccount: Address, destination: Address) =>
    getSettlePullInstruction({
      authority: h.executor,
      config: routerPdas.config(),
      mint: h.mint,
      inventory: routerPdas.inventory(),
      pull: pullAccount,
      destination,
      settlement: routerPdas.settlement(ref),
      refHash: sha256(ref),
    });

  it('pays an authorised pull to its payee, for exactly its amount, once', async () => {
    const { m, payee, pull } = await mandate();
    const ref = await pull('7');
    const r = await h.adapter.settlePull({ mandateId: m.mandateId, ref });
    expect(r.status).toBe('submitted');
    expect(await h.balanceOf(payee.address)).toBe(usd('7'));
    expect(await h.adapter.settlement(ref)).toMatchObject({ amount: usd('7'), refunded: 0n });
    expect((await h.adapter.settlePull({ mandateId: m.mandateId, ref })).status).toBe('duplicate');
    expect(await h.balanceOf(payee.address)).toBe(usd('7'));
  });

  it('a paid pull can no longer have its allowance restored', async () => {
    const { m, pull } = await mandate();
    const ref = await pull('10');
    await h.adapter.settlePull({ mandateId: m.mandateId, ref });
    await refusedOnChain(h.adapter.restoreAllowance({ mandateId: m.mandateId, ref }), 'INVALID_AMOUNT', 'NotRestorable');
    expect((await h.adapter.remaining(m.mandateId)).epoch).toBe(usd('40'));
  });

  it('a restored pull cannot be paid', async () => {
    const { m, pull } = await mandate();
    const ref = await pull('10');
    await h.adapter.restoreAllowance({ mandateId: m.mandateId, ref });
    await refusedOnChain(h.adapter.settlePull({ mandateId: m.mandateId, ref }), 'UNAUTHORIZED', 'PullNotSettleable');
  });

  it('a pull already paid from the vault cannot be paid again by the router', async () => {
    const { m, payee, pull } = await mandate();
    const ref = await pull('10', true);
    await refusedOnChain(h.adapter.settlePull({ mandateId: m.mandateId, ref }), 'UNAUTHORIZED', 'PullNotSettleable');
    expect(await h.balanceOf(payee.address)).toBe(usd('10'));
  });

  it('pays only the pull’s payee', async () => {
    const { m, pull } = await mandate();
    const other = await h.newWallet();
    const ref = await pull('10');
    const ix = await settlePullIx(ref, allowancePdas.pull(allowancePdas.mandate(m.mandateId), ref), await ata(other.address));
    await refusedOnChain(h.transport.send([ix], [h.executor]), 'UNAUTHORIZED', 'WrongPayee');
    expect(await h.balanceOf(other.address)).toBe(0n);
  });

  it('refuses anything that is not that authorised pull record', async () => {
    const { m, payee, pull } = await mandate();
    const ref = await pull('10');
    const mandateAddr = allowancePdas.mandate(m.mandateId);
    const dest = await ata(payee.address);
    // Another account of the allowance program (the mandate itself).
    await refusedOnChain(h.transport.send([await settlePullIx(ref, mandateAddr, dest)], [h.executor]), 'UNAUTHORIZED', 'NotAnAuthorizedPull');
    // An account of another program.
    await refusedOnChain(h.transport.send([await settlePullIx(ref, routerPdas.config(), dest)], [h.executor]), 'UNAUTHORIZED', 'NotAnAuthorizedPull');
    // A real pull record, claimed under a different ref.
    const otherRef = `pull_${randomUUID()}`;
    await refusedOnChain(
      h.transport.send([await settlePullIx(otherRef, allowancePdas.pull(mandateAddr, ref), dest)], [h.executor]),
      'UNAUTHORIZED',
      'NotAnAuthorizedPull',
    );
    expect(await h.balanceOf(payee.address)).toBe(0n);
  });

  it('there is no pull to pay for a ref that was never authorised', async () => {
    const { m } = await mandate();
    expect(await h.adapter.settlePull({ mandateId: m.mandateId, ref: 'never' }).then(() => null, (e) => (e as ChainError).code)).toBe('UNAUTHORIZED');
  });
});
