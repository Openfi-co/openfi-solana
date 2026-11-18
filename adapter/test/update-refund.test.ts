import { randomUUID } from 'node:crypto';
import { newSessionKey } from '@openfi/chain-conformance';
import { ChainError, toBaseUnits, type OnChainMandate, type PullIntent } from '@openfi/chain-interface';
import { generateKeyPairSigner, type Address, type TransactionSigner } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { beforeAll, describe, expect, it } from 'vitest';
import { getReturnSettlementInstruction, getUpdateMandateInstruction } from '../src/generated/allowance/index.js';
import { getRefundInstruction, OPENFI_ROUTER_PROGRAM_ADDRESS } from '../src/generated/router/index.js';
import { allowancePdas, routerPdas } from '../src/pdas.js';
import { toChainError } from '../src/errors.js';
import { createLiteSvmHarness } from './harness.js';

const usd = (a: string) => toBaseUnits(a, 6);

describe('update_mandate and refund', () => {
  let h: Awaited<ReturnType<typeof createLiteSvmHarness>>;

  beforeAll(async () => {
    h = await createLiteSvmHarness();
    await h.fundRouter(usd('1000'));
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
    const key = newSessionKey();
    await h.adapter.issueSession({ mandateId: m.mandateId, sessionPubkey: key.pubkey, subCap: usd('50'), expiresAt: m.expiresAt });
    const pull = async (amount: string, nonce: number) => {
      const intent: PullIntent = { mandateId: m.mandateId, payee: payee.address, amount: usd(amount), ref: randomUUID(), nonce, expiresAt: (await h.now()) + 300 };
      return h.adapter.authorizePull({ intent, sessionPubkey: key.pubkey, signature: key.sign(h.adapter.encodeIntent(intent)) });
    };
    return { m, principal, pull, vault: allowancePdas.vault(allowancePdas.mandate(m.mandateId)) };
  }

  const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof ChainError ? e.code : e));
  const send = (ix: Parameters<typeof h.transport.send>[0][number], signer = h.executor) =>
    h.transport.send([ix], [h.executor, signer]).then(
      () => null,
      (e) => (toChainError(e, null) as ChainError).code ?? e,
    );

  describe('update_mandate', () => {
    it('tightens the daily cap and kills intents signed against the old terms', async () => {
      const { m, pull } = await mandate();
      for (let i = 0; i < 3; i++) await pull('10', 0);

      const r = await h.adapter.updateMandate(m.mandateId, { epochCap: usd('40') });
      expect(r.status).toBe('submitted');
      expect(r.nonce).toBe(1);
      expect(await h.adapter.mandateNonce(m.mandateId)).toBe(1);
      expect((await h.adapter.remaining(m.mandateId)).epoch).toBe(usd('10'));

      // An intent the agent signed before the update is dead, even within the new cap.
      expect(await code(pull('10', 0))).toBe('STALE_NONCE');
      await pull('10', 1);
      expect(await code(pull('10', 1))).toBe('EPOCH_CAP_EXCEEDED');
    });

    it('lowers the per-pull cap and replaces the payee list', async () => {
      const { m, pull } = await mandate();
      const other = await verified();
      await h.adapter.updateMandate(m.mandateId, { perPullCap: usd('5') });
      expect(await code(pull('10', 1))).toBe('PER_PULL_CAP_EXCEEDED');
      await pull('5', 1);
      await h.adapter.updateMandate(m.mandateId, { payees: [other.address] });
      expect(await code(pull('5', 2))).toBe('PAYEE_NOT_ALLOWED');
    });

    it('rejects invalid terms and leaves the nonce alone', async () => {
      const { m } = await mandate();
      expect(await code(h.adapter.updateMandate(m.mandateId, { perPullCap: 0n }))).toBe('INVALID_AMOUNT');
      expect(await code(h.adapter.updateMandate(m.mandateId, { expiresAt: (await h.now()) - 1 }))).toBe('INVALID_AMOUNT');
      expect(await h.adapter.mandateNonce(m.mandateId)).toBe(0);
    });

    it('cannot revive a revoked mandate', async () => {
      const { m } = await mandate();
      await h.adapter.revokeMandate(m.mandateId);
      expect(await code(h.adapter.updateMandate(m.mandateId, { epochCap: usd('100') }))).toBe('MANDATE_REVOKED');
    });

    it('only the principal can update', async () => {
      const { m } = await mandate();
      const stranger = await generateKeyPairSigner();
      const ix = getUpdateMandateInstruction({
        principal: stranger,
        mandate: allowancePdas.mandate(m.mandateId),
        payees: null, perPullCap: null, epochCap: usd('1000'), totalCap: null, expiresAt: null, requiredLevel: null,
      });
      expect(await send(ix, stranger)).toBe('UNAUTHORIZED');
    });
  });

  describe('refund', () => {
    it('returns a settled vault top-up to inventory, partially and then in full, never more', async () => {
      const { m, vault } = await mandate();
      const ref = `chg_${randomUUID()}`;
      await h.adapter.settle({ ref, destination: vault, amount: usd('10') });
      const inventory = await h.tokenBalance(routerPdas.inventory());

      await h.adapter.returnSettlement({ mandateId: m.mandateId, ref, amount: usd('4') });
      expect(await h.tokenBalance(vault)).toBe(usd('6'));
      expect(await h.tokenBalance(routerPdas.inventory())).toBe(inventory + usd('4'));
      expect((await h.adapter.settlement(ref))!.refunded).toBe(usd('4'));

      // The vault has $6 left but only $6 of this settlement is unrefunded: $7 is refused.
      await h.fundVault(m.mandateId, usd('5'));
      expect(await code(h.adapter.returnSettlement({ mandateId: m.mandateId, ref, amount: usd('7') }))).toBe('INVALID_AMOUNT');
      await h.adapter.returnSettlement({ mandateId: m.mandateId, ref, amount: usd('6') });
      expect((await h.adapter.settlement(ref))!.refunded).toBe(usd('10'));
      expect(await code(h.adapter.returnSettlement({ mandateId: m.mandateId, ref, amount: usd('1') }))).toBe('INVALID_AMOUNT');
      expect(await h.tokenBalance(vault)).toBe(usd('5'));
    });

    it('cannot pull a refund out of a vault the settlement did not pay', async () => {
      const a = await mandate();
      const b = await mandate();
      const ref = `chg_${randomUUID()}`;
      await h.adapter.settle({ ref, destination: a.vault, amount: usd('10') });
      await h.fundVault(b.m.mandateId, usd('10'));
      expect(await code(h.adapter.returnSettlement({ mandateId: b.m.mandateId, ref, amount: usd('10') }))).toBe('UNAUTHORIZED');
      expect(await h.tokenBalance(b.vault)).toBe(usd('10'));
    });

    it('only the operator can return a vault top-up', async () => {
      const { m, vault } = await mandate();
      const ref = `chg_${randomUUID()}`;
      await h.adapter.settle({ ref, destination: vault, amount: usd('10') });
      const stranger = await generateKeyPairSigner();
      const mandateAddr = allowancePdas.mandate(m.mandateId);
      const ix = getReturnSettlementInstruction({
        operator: stranger,
        config: allowancePdas.config(),
        mandate: mandateAddr,
        vault,
        mint: h.mint,
        routerConfig: routerPdas.config(),
        routerInventory: routerPdas.inventory(),
        settlement: routerPdas.settlement(ref),
        routerProgram: OPENFI_ROUTER_PROGRAM_ADDRESS,
        amount: usd('10'),
      });
      expect(await send(ix, stranger)).toBe('UNAUTHORIZED');
      expect(await h.tokenBalance(vault)).toBe(usd('10'));
    });

    it('a wallet that was paid directly can refund by signing itself; nobody else can', async () => {
      const w = await h.newWallet();
      const [ata] = await findAssociatedTokenPda({ owner: w.address as Address, mint: h.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const ref = `chg_${randomUUID()}`;
      await h.adapter.settle({ ref, destination: w.address, amount: usd('3') });
      const refund = (signer: TransactionSigner) =>
        getRefundInstruction({
          sourceAuthority: signer,
          config: routerPdas.config(),
          mint: h.mint,
          inventory: routerPdas.inventory(),
          settlement: routerPdas.settlement(ref),
          source: ata,
          amount: usd('3'),
        });
      const stranger = await generateKeyPairSigner();
      expect(await send(refund(stranger), stranger)).toBe('UNAUTHORIZED');
      expect(await h.balanceOf(w.address)).toBe(usd('3'));
      expect(await send(refund(h.signerOf(w.address)), h.signerOf(w.address))).toBeNull();
      expect(await h.balanceOf(w.address)).toBe(0n);
    });

    it('the refund is recorded against the settlement ref', async () => {
      const { m, vault } = await mandate();
      const ref = `chg_${randomUUID()}`;
      await h.adapter.settle({ ref, destination: vault, amount: usd('2') });
      await h.adapter.returnSettlement({ mandateId: m.mandateId, ref, amount: usd('2') });
      const s = await h.adapter.settlement(ref);
      expect(s).toEqual({ destination: vault, amount: usd('2'), refunded: usd('2') });
    });
  });
});
