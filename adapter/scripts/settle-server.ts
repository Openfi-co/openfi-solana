// Bank-debit settlement listener.
//
// Receives the "payment cleared" webhook from Flick's open banking sandbox and
// settles the same amount in USDC on Solana through the Settlement Router,
// into the vault of the mandate the debit was made for. The bank charge ID is
// the router's settlement reference, so the same debit can never settle twice.
// If the debit is later returned, the USDC still in that vault goes back to
// the router's inventory against the same reference.
//
//   npx tsx scripts/settle-server.ts
//
// Env: WEBHOOK_SECRET (sandbox signing secret), WEBHOOK_SIGNATURE_HEADER,
//      WEBHOOK_TIMESTAMP_HEADER, BANK_API_BASE (sandbox base URL),
//      OPENFI_KEY (router authority keypair), SOLANA_RPC, PORT (default 8788).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { address, createKeyPairSignerFromBytes } from '@solana/kit';
import { getTokenDecoder } from '@solana-program/token';
import { isChainError } from '@openfi/chain-interface';
import { SolanaChainAdapter, SOLANA_DEVNET } from '../src/adapter.js';
import { allowancePdas } from '../src/pdas.js';
import { RpcTransport } from '../src/rpc-transport.js';

const need = (k: string) => process.env[k] ?? (console.error(`missing env ${k}`), process.exit(1));
const WEBHOOK_SECRET = need('WEBHOOK_SECRET');
const BANK_API_BASE = process.env.BANK_API_BASE ?? 'http://127.0.0.1:43181';
// Header names are the rail's; set them in .env (see .env.example).
const SIG_HEADER = need('WEBHOOK_SIGNATURE_HEADER').toLowerCase();
const TS_HEADER = need('WEBHOOK_TIMESTAMP_HEADER').toLowerCase();
const MAX_SKEW_SECS = 300;
const PORT = Number(process.env.PORT ?? 8788);
const USDC = address(process.env.USDC_MINT ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const transport = new RpcTransport(process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com', 'devnet');
const keyPath = (process.env.OPENFI_KEY ?? '~/.config/solana/openfi-devnet.json').replace(/^~/, homedir());
const authority = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(keyPath, 'utf8'))));
// The listener only settles; it never acts for a principal.
const adapter = new SolanaChainAdapter({ transport, executor: authority, mint: USDC, chainId: SOLANA_DEVNET, signerFor: () => undefined });

interface Instruction {
  kind: 'settle' | 'return';
  chargeId: string;
  /** USDC base units (6 decimals). */
  amount: bigint;
  mandateId: string;
}

/**
 * The webhook carries only the charge ID and status: {"data":{"id":"chg_...","status":"paid"}}.
 * `paid` means the debit cleared; `returned` means it came back afterwards.
 * Amount and mandate come from the charge itself, so a forged or stale body
 * cannot change what settles.
 */
async function parseDebitEvent(body: { data?: { id?: string; status?: string; return_code?: string } }): Promise<Instruction | null> {
  const { id, status, return_code: returnCode } = body?.data ?? {};
  if (!id) throw new Error('missing charge id');
  if (status !== 'paid' && status !== 'returned') return null;
  const res = await fetch(`${BANK_API_BASE}/api/charges/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`charge lookup ${res.status}`);
  const { payment } = (await res.json()) as { payment?: { status?: string; invoiceCents?: number; amountCents?: number; metadata?: Record<string, string> } };
  const mandateId = payment?.metadata?.mandate_id;
  if (!mandateId) throw new Error(`charge ${id} has no mandate_id`);
  if (status === 'returned') {
    // Returns arrive after `paid` (days later in production). The amount to
    // recover is whatever the router settled for this charge.
    console.warn(`returned debit ${id} (${returnCode ?? 'no code'})`);
    return { kind: 'return', chargeId: id, amount: 0n, mandateId };
  }
  // The signed webhook is the clearing signal; the lookup supplies amount and
  // mandate and blocks charges the bank side already marked bad.
  if (['failed', 'cancelled', 'returned'].includes(payment?.status ?? '')) throw new Error(`charge ${id} is ${payment!.status}`);
  // Settle the invoice amount; the 1% rail fee is not converted.
  const cents = payment?.invoiceCents ?? payment?.amountCents;
  if (!cents || cents <= 0) throw new Error('missing amount');
  // cents → USDC base units: 1 cent = 10^4 units at 6 decimals.
  return { kind: 'settle', chargeId: id, amount: BigInt(cents) * 10_000n, mandateId };
}

/** Hex HMAC-SHA256 over `${timestamp}.${rawBody}`; reject stale timestamps. */
function verified(raw: Buffer, sig: unknown, ts: unknown): boolean {
  if (typeof sig !== 'string' || typeof ts !== 'string' || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECS) return false;
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.`).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function settle({ chargeId, amount, mandateId }: Instruction) {
  const r = await adapter.settle({ ref: chargeId, mandateId, amount });
  return r.status === 'duplicate' ? { status: 'already_settled' } : { status: 'settled', tx: r.explorerUrl };
}

/**
 * Send back what this charge settled, as far as the vault still holds it.
 * Anything the agent already spent is a shortfall to recover off-chain.
 */
async function returnFunds({ chargeId, mandateId }: Instruction) {
  const s = await adapter.settlement(chargeId);
  if (!s) return { status: 'nothing_settled' };
  const owed = s.amount - s.refunded;
  if (owed === 0n) return { status: 'already_returned' };
  const acc = await transport.getAccount(allowancePdas.vault(allowancePdas.mandate(mandateId)));
  const held = acc ? getTokenDecoder().decode(acc.data).amount : 0n;
  const amount = held < owed ? held : owed;
  if (amount < owed) console.warn(`  shortfall ${Number(owed - amount) / 1e6} USDC already spent from the vault`);
  if (amount === 0n) return { status: 'vault_empty' };
  const r = await adapter.returnSettlement({ mandateId, ref: chargeId, amount });
  return { status: `returned ${Number(amount) / 1e6} USDC`, tx: r.explorerUrl };
}

const json = (res: import('node:http').ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhooks/bank-debit') return json(res, 404, { error: 'not_found' });
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    if (!verified(raw, req.headers[SIG_HEADER], req.headers[TS_HEADER])) return json(res, 401, { error: 'bad_signature' });
    try {
      const instruction = await parseDebitEvent(JSON.parse(raw.toString('utf8')));
      if (!instruction) return json(res, 200, { status: 'ignored' });
      // Acknowledge at once; on-chain settlement takes a few seconds and the
      // sender should not time out and redeliver while it runs.
      json(res, 202, { payment_id: instruction.chargeId, status: 'accepted' });
      if (instruction.kind === 'settle') {
        console.log(`cleared debit ${instruction.chargeId}: ${Number(instruction.amount) / 1e6} USDC -> vault of ${instruction.mandateId}`);
      }
      (instruction.kind === 'settle' ? settle(instruction) : returnFunds(instruction))
        .then((out) => console.log(`  ${out.status}${out.tx ? ` ${out.tx}` : ''}`))
        .catch((e) => console.error(`  settlement error: ${isChainError(e) ? `${e.code} ${e.explorerUrl ?? ''}` : (e as Error).message}`));
    } catch (e) {
      console.error(`  error: ${(e as Error).message}`);
      json(res, 500, { error: 'settlement_failed' });
    }
  });
}).listen(PORT, () => console.log(`listening on :${PORT}/webhooks/bank-debit (router authority ${authority.address})`));
