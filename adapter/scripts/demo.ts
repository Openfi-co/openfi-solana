// Devnet demo: the build plan's scenario on the deployed programs, with real
// (devnet) USDC. Every step prints an Explorer link; rejected steps are
// submitted anyway, so the rejection is a failed transaction on the ledger.
//
//   OPENFI_KEY=~/.config/solana/openfi-devnet.json npm run demo
//   BANK_DEBIT=1 npm run demo     a Flick sandbox bank debit funds the vault; needs
//                                 the sandbox and scripts/settle-server.ts running
//
// The key is OpenFi's executor: it pays fees and acts as identity issuer,
// allowance operator and router authority. It must hold devnet SOL and USDC.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type Address,
  type TransactionSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTokenDecoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { newSessionKey } from '@openfi/chain-conformance';
import { ChainError, toBaseUnits, type PullIntent } from '@openfi/chain-interface';
import { SolanaChainAdapter, SOLANA_DEVNET } from '../src/adapter.js';
import { getInitConfigInstruction } from '../src/generated/allowance/index.js';
import { getInitRegistryInstruction } from '../src/generated/identity/index.js';
import { getInitRouterInstruction } from '../src/generated/router/index.js';
import { allowancePdas, identityPdas, routerPdas } from '../src/pdas.js';
import { RpcTransport } from '../src/rpc-transport.js';
import { debitLinked, describeDebit, linkBank, maskedAccount, type Link } from './start-debit.js';

const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // Circle devnet USDC
const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const keyPath = (process.env.OPENFI_KEY ?? '~/.config/solana/openfi-devnet.json').replace(/^~/, homedir());
const usd = (a: string) => toBaseUnits(a, 6);

const t = new RpcTransport(RPC, 'devnet');
const executor = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(keyPath, 'utf8'))));
const wallets = new Map<string, TransactionSigner>();
const adapter = new SolanaChainAdapter({ transport: t, executor, mint: USDC, chainId: SOLANA_DEVNET, signerFor: (a) => wallets.get(a) });

const run = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const evidenceDir = new URL(`../../evidence/devnet-${run}${process.env.BANK_DEBIT ? '-flick-debit' : ''}/`, import.meta.url).pathname;
mkdirSync(evidenceDir, { recursive: true });
const rows: { step: string; result: string; signature: string }[] = [];

async function record(step: string, p: Promise<{ txId: string | null; status: string }>, expectReject?: string) {
  try {
    const r = await p;
    if (expectReject) throw new Error(`${step}: expected ${expectReject}, but it succeeded`);
    if (!r.txId) throw new Error(`${step}: nothing was submitted (${r.status})`);
    await save(step, 'accepted', r.txId);
  } catch (e) {
    if (!(e instanceof ChainError) || !expectReject) throw e;
    if (e.code !== expectReject) throw new Error(`${step}: expected ${expectReject}, got ${e.code}`);
    if (!e.txId) throw new Error(`${step}: rejected off-chain; the demo needs an on-chain rejection`);
    await save(step, `rejected on-chain: ${e.code}`, e.txId);
  }
}

async function save(step: string, result: string, signature: string) {
  rows.push({ step, result, signature });
  writeFileSync(`${evidenceDir}${String(rows.length).padStart(2, '0')}-${signature}.json`, JSON.stringify(await t.rawTransaction(signature), (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`${result.startsWith('rejected') ? '✗' : '✓'} ${step.padEnd(52)} ${result}\n    ${t.explorerUrl(signature)}`);
}

const send = (ixs: Parameters<typeof t.send>[0]) => t.send(ixs, [executor]);
const ata = async (owner: Address) => (await findAssociatedTokenPda({ owner, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
const hex32 = () => randomBytes(32).toString('hex');

// ------------------------------------------------------------------ setup (idempotent)

console.log(`executor ${executor.address}\n`);
if (!(await t.getAccount(identityPdas.registry()))) {
  const { signature } = await send([
    getInitRegistryInstruction({ admin: executor, registry: identityPdas.registry(), issuer: executor.address }),
    getInitConfigInstruction({ admin: executor, config: allowancePdas.config(), operator: executor.address }),
    getInitRouterInstruction({ admin: executor, config: routerPdas.config(), mint: USDC, inventory: routerPdas.inventory(), authority: executor.address }),
  ]);
  await save('Initialise registry, allowance config, router (USDC)', 'accepted', signature);
}

// Top the router's float up to 10 USDC from the executor's USDC.
const inventory = routerPdas.inventory();
const tokenBalance = async (a: Address) => {
  const acc = await t.getAccount(a);
  return acc ? getTokenDecoder().decode(acc.data).amount : 0n;
};
const shortfall = usd('10') - (await tokenBalance(inventory));
if (shortfall > 0n) {
  const { signature } = await send([
    getTransferCheckedInstruction({ source: await ata(executor.address), mint: USDC, destination: inventory, authority: executor, amount: shortfall, decimals: 6 }),
  ]);
  await save(`Fund router float: ${Number(shortfall) / 1e6} USDC`, 'accepted', signature);
}

// BANK_DEBIT=1: the principal links their (sandbox) bank account first; a bank
// debit then funds the mandate's vault through the router.
const BANK_API_BASE = process.env.BANK_API_BASE ?? 'http://127.0.0.1:43181';
const link: Link | null = process.env.BANK_DEBIT ? await linkBank({ base: BANK_API_BASE, usd: 10 }) : null;
if (link) console.log(`Bank account linked (Flick sandbox, simulated bank): ${maskedAccount(link)}\n`);

// ------------------------------------------------------------------ actors (no SOL: the executor pays)

const principal = await generateKeyPairSigner();
const merchant = await generateKeyPairSigner();
const bot = await generateKeyPairSigner();
for (const w of [principal, merchant, bot]) wallets.set(w.address, w);
const agent = newSessionKey();
console.log(`principal ${principal.address}\nmerchant  ${merchant.address}\nbot       ${bot.address}\n`);

await record('Anchor credential: principal (bank-verified)', adapter.anchorCredential({ subject: principal.address, commitment: hex32(), level: 'bank_verified', expiresAt: (await t.now()) + 365 * 86400, nullifier: hex32() }));
await record('Anchor credential: merchant (bank-verified)', adapter.anchorCredential({ subject: merchant.address, commitment: hex32(), level: 'bank_verified', expiresAt: (await t.now()) + 365 * 86400, nullifier: hex32() }));
await send([getCreateAssociatedTokenIdempotentInstruction({ payer: executor, ata: await ata(merchant.address), owner: merchant.address, mint: USDC })]);

// ------------------------------------------------------------------ scenario

const terms = async (mandateId: string, who: Address) => ({
  mandateId, principal: who, token: USDC, payees: [merchant.address],
  perPullCap: usd('10'), epochSeconds: 86400, epochCap: usd('50'), totalCap: usd('1500'),
  expiresAt: (await t.now()) + 30 * 86400, requiredLevel: 'bank_verified' as const, nonce: 0,
});

await record('Bot wallet (no credential) creates a mandate', adapter.createMandate(await terms(`mnd_bot_${randomUUID()}`, bot.address)), 'IDENTITY_REQUIRED');

const mandateId = `mnd_${randomUUID()}`;
await record('Mandate: $50/day, $10 per pull, 1 payee', adapter.createMandate(await terms(mandateId, principal.address)));
await record('Agent session key issued ($50/day)', adapter.issueSession({ mandateId, sessionPubkey: agent.pubkey, subCap: usd('50'), expiresAt: (await t.now()) + 30 * 86400 }));

const vault = allowancePdas.vault(allowancePdas.mandate(mandateId));
if (link) {
  // A real sandbox debit. The sandbox fires a signed `paid` webhook at
  // settle-server.ts, which settles through the router; wait for it to land.
  const payment = await debitLinked(link, mandateId);
  console.log(`Flick sandbox bank debit: ${describeDebit(payment, link)}`);
  const settlement = routerPdas.settlement(payment.chargeId);
  const deadline = Date.now() + 120_000;
  while (!(await t.getAccount(settlement))) {
    if (Date.now() > deadline) throw new Error(`no settlement for ${payment.chargeId}: is settle-server.ts running and registered with the sandbox?`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const [sig] = await t.signaturesFor(settlement, 1);
  await save(`Bank debit ${payment.chargeId} cleared: router settles 10 USDC to vault`, 'accepted', sig!);
} else {
  await record('Bank debit cleared: router settles 10 USDC to vault', adapter.settle({ ref: `chg_demo_${randomUUID()}`, destination: vault, amount: usd('10') }));
}

async function pull(kind: 'execute' | 'authorize', amount: string) {
  const intent: PullIntent = { mandateId, payee: merchant.address, amount: usd(amount), ref: `pull_${randomUUID()}`, nonce: 0, expiresAt: (await t.now()) + 300 };
  const signed = { intent, sessionPubkey: agent.pubkey, signature: agent.sign(adapter.encodeIntent(intent)) };
  return kind === 'execute' ? adapter.executePull(signed) : adapter.authorizePull(signed);
}

await record('Pull 1: $10 USDC vault → merchant (execute_pull)', pull('execute', '10'));
for (let i = 2; i <= 5; i++) await record(`Pull ${i}: $10 (authorize_pull, bank side)`, pull('authorize', '10'));
await record('Pull 6: $10, over the $50/day cap', pull('authorize', '10'), 'EPOCH_CAP_EXCEEDED');
await record('Principal revokes the mandate', adapter.revokeMandate(mandateId));
await record('Pull 7: $1 after revocation', pull('authorize', '1'), 'MANDATE_REVOKED');

const merchantUsdc = await tokenBalance(await ata(merchant.address));
console.log(`\nmerchant USDC balance: ${Number(merchantUsdc) / 1e6}`);

// The demo merchant is a throwaway wallet; return its USDC to the executor so
// the next run can reuse it (devnet USDC is rate-limited at the faucet). Not
// part of the evidence.
if (merchantUsdc > 0n) {
  await send([
    getTransferCheckedInstruction({ source: await ata(merchant.address), mint: USDC, destination: await ata(executor.address), authority: merchant, amount: merchantUsdc, decimals: 6 }),
  ]);
  console.log(`returned ${Number(merchantUsdc) / 1e6} USDC from the demo merchant to the executor`);
}

// ------------------------------------------------------------------ evidence index

const md = [
  `# Devnet run ${run}`,
  '',
  `Programs: identity \`8LeyKvcY9XkHYt6WePMdwc8cpRHCoXsVqkXY1QJ7Q5Yo\`, allowance \`9BNvSF8bUEQJaBbWxBmtjRnBH1qmM47JpWWDwKM8Cs1B\`, router \`d85jMjdA3wUtjeD1wBuAarMMcYczSmNyWajJSxpW7UL\`. Token: Circle devnet USDC \`${USDC}\`.`,
  '',
  `Mandate \`${allowancePdas.mandate(mandateId)}\` · principal \`${principal.address}\` · merchant \`${merchant.address}\` · bot \`${bot.address}\``,
  '',
  '| # | Step | Result | Transaction |',
  '|---|---|---|---|',
  ...rows.map((r, i) => `| ${i + 1} | ${r.step} | ${r.result} | [${r.signature.slice(0, 8)}…](${t.explorerUrl(r.signature)}) |`),
  '',
  `Merchant USDC after the run: ${Number(merchantUsdc) / 1e6}`,
  '',
];
writeFileSync(`${evidenceDir}README.md`, md.join('\n'));
console.log(`evidence: ${evidenceDir}`);
