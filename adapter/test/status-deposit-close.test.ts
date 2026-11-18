import { randomBytes, randomUUID } from 'node:crypto';
import { newSessionKey } from '@openfi/chain-conformance';
import { ChainError, toBaseUnits, type OnChainMandate, type PullIntent } from '@openfi/chain-interface';
import { generateKeyPairSigner, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { beforeAll, describe, expect, it } from 'vitest';
import { getCloseInstruction, getDepositInstruction } from '../src/generated/allowance/index.js';
import { getRotateStatusRootInstruction } from '../src/generated/identity/index.js';
import { toChainError } from '../src/errors.js';
import { allowancePdas, identityPdas } from '../src/pdas.js';
import { TxFailure } from '../src/transport.js';
import { createLiteSvmHarness } from './harness.js';

const usd = (a: string) => toBaseUnits(a, 6);
const hex32 = () => randomBytes(32).toString('hex');

describe('rotate_status_root, deposit and close', () => {
  let h: Awaited<ReturnType<typeof createLiteSvmHarness>>;

  beforeAll(async () => {
    h = await createLiteSvmHarness();
    await h.fundRouter(usd('1000'));
  });

  async function verified() {
    const w = await h.newWallet();
    await h.adapter.anchorCredential({ subject: w.address, commitment: hex32(), level: 'bank_verified', expiresAt: (await h.now()) + 86400, nullifier: hex32() });
    return w;
  }

  async function mandate(mandateId = `mnd_${randomUUID()}`) {
    const principal = await verified();
    const payee = await verified();
    const m: OnChainMandate = {
      mandateId, principal: principal.address, token: h.adapter.token, payees: [payee.address],
      perPullCap: usd('10'), epochSeconds: 86400, epochCap: usd('50'), totalCap: usd('1500'),
      expiresAt: (await h.now()) + 86400, requiredLevel: 'bank_verified', nonce: 0,
    };
    await h.adapter.createMandate(m);
    const key = newSessionKey();
    await h.adapter.issueSession({ mandateId: m.mandateId, sessionPubkey: key.pubkey, subCap: usd('50'), expiresAt: m.expiresAt });
    const pull = async (amount: string, execute = true) => {
      const intent: PullIntent = { mandateId: m.mandateId, payee: payee.address, amount: usd(amount), ref: randomUUID(), nonce: 0, expiresAt: (await h.now()) + 300 };
      const signed = { intent, sessionPubkey: key.pubkey, signature: key.sign(h.adapter.encodeIntent(intent)) };
      return execute ? h.adapter.executePull(signed) : h.adapter.authorizePull(signed);
    };
    const principalAta = (await findAssociatedTokenPda({ owner: principal.address as Address, mint: h.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
    return { m, principal, payee, pull, principalAta, vault: allowancePdas.vault(allowancePdas.mandate(m.mandateId)) };
  }

  const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof ChainError ? e.code : e));
  const send = (ix: Instruction, signers: TransactionSigner[]) =>
    h.transport.send([ix], [h.executor, ...signers]).then(
      () => null,
      (e) => {
        const c = toChainError(e, null);
        return c instanceof ChainError ? c.code : c;
      },
    );

  describe('rotate_status_root', () => {
    it('publishes the status-list root and only moves forward', async () => {
      expect(await h.adapter.statusRoot()).toBeNull();
      const first = hex32();
      await h.adapter.rotateStatusRoot({ root: first, version: 1 });
      expect(await h.adapter.statusRoot()).toMatchObject({ root: first, version: 1 });

      const second = hex32();
      await h.adapter.rotateStatusRoot({ root: second, version: 2 });
      // Replaying the older list (from before a revocation) is refused on-chain.
      expect(await code(h.adapter.rotateStatusRoot({ root: first, version: 1 }))).toBe('INVALID_AMOUNT');
      expect(await code(h.adapter.rotateStatusRoot({ root: first, version: 2 }))).toBe('INVALID_AMOUNT');
      expect(await h.adapter.statusRoot()).toMatchObject({ root: second, version: 2 });
    });

    it('only the issuer can rotate it', async () => {
      const stranger = await generateKeyPairSigner();
      const ix = getRotateStatusRootInstruction({
        issuer: stranger,
        registry: identityPdas.registry(),
        status: identityPdas.status(),
        root: randomBytes(32),
        version: 99,
      });
      expect(await send(ix, [stranger])).toBe('UNAUTHORIZED');
    });
  });

  describe('deposit', () => {
    it('the principal prefunds the vault and pulls draw it down', async () => {
      const { m, principal, payee, pull, vault } = await mandate();
      await h.fundWallet(principal.address, usd('30'));
      await h.adapter.deposit({ mandateId: m.mandateId, amount: usd('25') });
      expect(await h.balanceOf(principal.address)).toBe(usd('5'));
      expect(await h.tokenBalance(vault)).toBe(usd('25'));
      await pull('10');
      expect(await h.tokenBalance(vault)).toBe(usd('15'));
      expect(await h.balanceOf(payee.address)).toBe(usd('10'));
    });

    it('nobody else can deposit through the principal’s mandate, and a revoked mandate takes no deposits', async () => {
      const { m, principal, principalAta, vault } = await mandate();
      await h.fundWallet(principal.address, usd('10'));
      const stranger = await generateKeyPairSigner();
      const ix = getDepositInstruction({
        principal: stranger,
        mandate: allowancePdas.mandate(m.mandateId),
        principalToken: principalAta,
        vault,
        mint: h.mint,
        amount: usd('10'),
      });
      expect(await send(ix, [stranger])).toBe('UNAUTHORIZED');

      await h.adapter.revokeMandate(m.mandateId);
      expect(await code(h.adapter.deposit({ mandateId: m.mandateId, amount: usd('10') }))).toBe('MANDATE_REVOKED');
      expect(await h.balanceOf(principal.address)).toBe(usd('10'));
    });
  });

  describe('close', () => {
    it('returns the vault balance to the principal, closes the vault and revokes the mandate', async () => {
      const { m, principal, pull, vault } = await mandate();
      await h.fundVault(m.mandateId, usd('40'));
      await pull('10');
      await h.adapter.closeMandate(m.mandateId);

      expect(await h.balanceOf(principal.address)).toBe(usd('30'));
      expect(await h.transport.getAccount(vault)).toBeNull();
      // The session key is dead: bank-side pulls are refused as revoked.
      // Vault pulls and deposits fail on-chain because the vault is gone.
      expect(await code(pull('1', false))).toBe('MANDATE_REVOKED');
      expect(await code(pull('1'))).not.toBeNull();
      expect(await code(h.adapter.deposit({ mandateId: m.mandateId, amount: usd('1') }))).not.toBeNull();
      // Closing again is a no-op.
      expect((await h.adapter.closeMandate(m.mandateId)).status).toBe('duplicate');
    });

    it('the mandate id can never be reused, so old session keys stay dead', async () => {
      const { m } = await mandate();
      await h.adapter.closeMandate(m.mandateId);
      const err = await mandate(m.mandateId).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(TxFailure);
      expect(await h.transport.getAccount(allowancePdas.mandate(m.mandateId))).not.toBeNull();
    });

    it('needs the operator: the principal alone cannot close and withdraw', async () => {
      const { m, principal, principalAta, vault } = await mandate();
      await h.fundVault(m.mandateId, usd('10'));
      const stranger = await generateKeyPairSigner();
      const ix = getCloseInstruction({
        principal: h.signerOf(principal.address),
        operator: stranger,
        config: allowancePdas.config(),
        mandate: allowancePdas.mandate(m.mandateId),
        principalToken: principalAta,
        vault,
        mint: h.mint,
      });
      expect(await send(ix, [h.signerOf(principal.address), stranger])).toBe('UNAUTHORIZED');
      expect(await h.tokenBalance(vault)).toBe(usd('10'));
    });

    it('after close, a returned settlement can no longer be recovered from the vault', async () => {
      const { m, vault } = await mandate();
      const ref = `chg_${randomUUID()}`;
      await h.adapter.settle({ ref, destination: vault, amount: usd('5') });
      await h.adapter.closeMandate(m.mandateId);
      // This is why close needs the operator's signature.
      expect(await h.adapter.returnSettlement({ mandateId: m.mandateId, ref, amount: usd('5') }).then(() => 'ok', () => 'failed')).toBe('failed');
    });
  });
});
