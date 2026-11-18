import { randomUUID } from 'node:crypto';
import { newSessionKey } from '@openfi/chain-conformance';
import { ChainError, toBaseUnits, type OnChainMandate, type PullIntent } from '@openfi/chain-interface';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAddressDecoder, type Address } from '@solana/kit';
import { ed25519Instruction } from '../src/adapter.js';
import { getAuthorizePullInstruction } from '../src/generated/allowance/index.js';
import { allowancePdas, identityPdas, sha256 } from '../src/pdas.js';
import { TxFailure } from '../src/transport.js';
import { createLiteSvmHarness } from './harness.js';

/**
 * The conformance suite checks error codes. These tests check *where* the
 * rejection happened: each one must be a transaction the cluster executed and
 * failed, with the program's own error in the logs. An adapter that refused
 * off-chain would pass conformance and fail here.
 */
describe('rejections are enforced on-chain', () => {
  let h: Awaited<ReturnType<typeof createLiteSvmHarness>>;
  const usd = (a: string) => toBaseUnits(a, 6);
  const logs: string[][] = [];

  beforeAll(async () => {
    h = await createLiteSvmHarness();
    // Record logs of every failed transaction the adapter sends.
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
    await h.fundVault(m.mandateId, usd('100'));
    const key = newSessionKey();
    await h.adapter.issueSession({ mandateId: m.mandateId, sessionPubkey: key.pubkey, subCap: usd('50'), expiresAt: m.expiresAt });
    const pull = async (amount: string, over: Partial<PullIntent> = {}, signer = key) => {
      const intent: PullIntent = { mandateId: m.mandateId, payee: payee.address, amount: usd(amount), ref: randomUUID(), nonce: 0, expiresAt: (await h.now()) + 300, ...over };
      return h.adapter.authorizePull({ intent, sessionPubkey: key.pubkey, signature: signer.sign(h.adapter.encodeIntent(intent)) });
    };
    return { m, pull };
  }

  async function rejectedOnChain(p: Promise<unknown>, code: string, programError?: string) {
    const before = logs.length;
    const err = await p.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ChainError);
    expect((err as ChainError).code).toBe(code);
    expect((err as ChainError).txId, 'rejection must be a failed transaction').toBeTruthy();
    expect(logs.length).toBe(before + 1);
    if (programError) expect(logs.at(-1)!.join('\n')).toContain(`Error Code: ${programError}`);
  }

  it('sixth $10 pull of a $50/day mandate fails in the program', async () => {
    const { pull } = await mandate();
    for (let i = 0; i < 5; i++) await pull('10');
    await rejectedOnChain(pull('10'), 'EPOCH_CAP_EXCEEDED', 'EpochCapExceeded');
  });

  it('a pull after revocation fails in the program', async () => {
    const { m, pull } = await mandate();
    await h.adapter.revokeMandate(m.mandateId);
    await rejectedOnChain(pull('1'), 'MANDATE_REVOKED', 'MandateRevoked');
  });

  it('a bot wallet with no credential cannot create a mandate (identity program, via CPI)', async () => {
    const bot = await h.newWallet();
    const payee = await verified();
    await rejectedOnChain(
      h.adapter.createMandate({
        mandateId: `mnd_${randomUUID()}`, principal: bot.address, token: h.adapter.token, payees: [payee.address],
        perPullCap: usd('10'), epochSeconds: 86400, epochCap: usd('50'), totalCap: usd('100'),
        expiresAt: (await h.now()) + 86400, requiredLevel: 'bank_verified', nonce: 0,
      }),
      'IDENTITY_REQUIRED',
      'IdentityRequired',
    );
  });

  it('an intent signed by another key fails at the ed25519 precompile', async () => {
    const { pull } = await mandate();
    await rejectedOnChain(pull('1', {}, newSessionKey()), 'BAD_SIGNATURE');
  });

  it('a valid signature for $1 cannot authorise a $9 pull (program binds signature to intent)', async () => {
    // What an attacker would send: a genuine ed25519 proof for the $1 intent the
    // agent signed, followed by a pull instruction asking for $9. The precompile
    // passes; the allowance program must reject the mismatch itself.
    const { m } = await mandate();
    const payee = m.payees[0]! as Address;
    const key = newSessionKey();
    await h.adapter.issueSession({ mandateId: m.mandateId, sessionPubkey: key.pubkey, subCap: usd('50'), expiresAt: m.expiresAt });
    const signed: PullIntent = { mandateId: m.mandateId, payee, amount: usd('1'), ref: randomUUID(), nonce: 0, expiresAt: (await h.now()) + 300 };
    const message = h.adapter.encodeIntent(signed);
    const signature = Buffer.from(key.sign(message), 'hex');
    const sessionKey = getAddressDecoder().decode(Buffer.from(key.pubkey, 'hex'));
    const mandateAddr = allowancePdas.mandate(m.mandateId);

    const before = logs.length;
    const err = await h.transport
      .send(
        [
          ed25519Instruction(Buffer.from(key.pubkey, 'hex'), signature, message),
          getAuthorizePullInstruction({
            executor: h.executor,
            mandate: mandateAddr,
            session: allowancePdas.session(mandateAddr, sessionKey),
            pull: allowancePdas.pull(mandateAddr, signed.ref),
            payee,
            payeeCredential: identityPdas.credential(payee),
            intent: { payee, amount: usd('9'), refHash: sha256(signed.ref), nonce: 0, expiresAt: signed.expiresAt },
            sessionPubkey: sessionKey,
          }),
        ],
        [h.executor],
      )
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(TxFailure);
    expect(logs.length).toBe(before + 1);
    expect(logs.at(-1)!.join('\n')).toContain('Error Code: BadSignature');
  });
});
