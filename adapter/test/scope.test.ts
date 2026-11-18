import { randomUUID } from 'node:crypto';
import { newSessionKey } from '@openfi/chain-conformance';
import { ChainError, toBaseUnits, type OnChainMandate, type PullIntent } from '@openfi/chain-interface';
import { getAddressDecoder, type Address } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SessionScope } from '../src/adapter.js';
import { getIssueSessionInstruction } from '../src/generated/allowance/index.js';
import { toChainError } from '../src/errors.js';
import { allowancePdas } from '../src/pdas.js';
import { TxFailure } from '../src/transport.js';
import { createLiteSvmHarness } from './harness.js';

const usd = (a: string) => toBaseUnits(a, 6);
const addressOf = (hex: string) => getAddressDecoder().decode(Buffer.from(hex, 'hex')) as Address;

describe('session scope flags', () => {
  let h: Awaited<ReturnType<typeof createLiteSvmHarness>>;
  const logs: string[][] = [];

  beforeAll(async () => {
    h = await createLiteSvmHarness();
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

  async function withSession(scope: SessionScope[]) {
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
    await h.adapter.issueSession({ mandateId: m.mandateId, sessionPubkey: key.pubkey, subCap: usd('50'), expiresAt: m.expiresAt, scope });
    const signed = async (amount: string) => {
      const intent: PullIntent = { mandateId: m.mandateId, payee: payee.address, amount: usd(amount), ref: randomUUID(), nonce: 0, expiresAt: (await h.now()) + 300 };
      return { intent, sessionPubkey: key.pubkey, signature: key.sign(h.adapter.encodeIntent(intent)) };
    };
    return { m, payee, signed, vault: allowancePdas.vault(allowancePdas.mandate(m.mandateId)) };
  }

  async function refusedOnChain(p: Promise<unknown>, code: string, programError: string) {
    const before = logs.length;
    const err = await p.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ChainError);
    expect((err as ChainError).code).toBe(code);
    expect(logs.length).toBe(before + 1);
    expect(logs.at(-1)!.join('\n')).toContain(`Error Code: ${programError}`);
  }

  it('a bank-pull-only key can authorise pulls but never move tokens from the vault', async () => {
    const { signed, payee, vault } = await withSession(['authorize']);
    expect((await h.adapter.authorizePull(await signed('10'))).status).toBe('submitted');
    await refusedOnChain(h.adapter.executePull(await signed('10')), 'UNAUTHORIZED', 'ScopeNotAllowed');
    expect(await h.tokenBalance(vault)).toBe(usd('50'));
    expect(await h.balanceOf(payee.address)).toBe(0n);
  });

  it('a vault-only key can execute pulls but not authorise bank-side ones', async () => {
    const { signed, payee } = await withSession(['execute']);
    await h.adapter.executePull(await signed('10'));
    expect(await h.balanceOf(payee.address)).toBe(usd('10'));
    await refusedOnChain(h.adapter.authorizePull(await signed('10')), 'UNAUTHORIZED', 'ScopeNotAllowed');
  });

  it('the default scope allows both', async () => {
    const { signed } = await withSession(['authorize', 'execute']);
    await h.adapter.authorizePull(await signed('5'));
    await h.adapter.executePull(await signed('5'));
  });

  it('a key with no scope, or unknown scope bits, cannot be issued', async () => {
    const { m } = await withSession(['authorize']);
    const issue = (scope: number) => {
      const mandate = allowancePdas.mandate(m.mandateId);
      const key = newSessionKey();
      return h.transport
        .send(
          [
            getIssueSessionInstruction({
              payer: h.executor,
              principal: h.signerOf(m.principal),
              mandate,
              session: allowancePdas.session(mandate, addressOf(key.pubkey)),
              pubkey: addressOf(key.pubkey),
              subCap: usd('10'),
              expiresAt: m.expiresAt,
              scope,
            }),
          ],
          [h.executor, h.signerOf(m.principal)],
        )
        .then(() => null, (e) => (toChainError(e, null) as ChainError).code);
    };
    expect(await issue(0)).toBe('INVALID_AMOUNT');
    expect(await issue(4)).toBe('INVALID_AMOUNT');
    expect(await issue(1)).toBeNull();
  });
});
