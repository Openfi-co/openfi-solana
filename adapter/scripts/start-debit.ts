// One-off USD bank debit in Flick's open banking sandbox, tagged with the
// mandate it should fund. When it clears, the sandbox sends a signed `paid`
// webhook to settle-server.ts, which settles the same amount in USDC into the
// mandate's vault through the Settlement Router.
//
//   BANK_API_BASE=http://127.0.0.1:43181 npx tsx scripts/start-debit.ts <amount-usd> <mandate-id> [scenario]
//
// scenario: paid | returned | failed_insufficient_funds
export interface Link {
  base: string;
  scenario: string;
  customerId: string;
  paykey: { id: string; bankName: string; accountType?: string; last4: string };
}

export interface Payment {
  chargeId: string;
  status: string;
  invoiceCents: number;
  feeCents: number;
  totalCents: number;
  metadata?: Record<string, string>;
}

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(json)}`);
  return json as T;
}

/** Link the sandbox payer's test bank account for a debit of `usd`. */
export async function linkBank({ base, usd, scenario = 'paid' }: { base: string; usd: number; scenario?: string }): Promise<Link> {
  const amountCents = Math.round(usd * 100);
  const { customerId } = await post<{ customerId: string }>(base, '/api/checkout/start', { amountCents, scenario });
  const paykey = await post<Link['paykey']>(base, '/api/paykey', { customerId, bankId: 'fe' });
  return { base, scenario, customerId, paykey };
}

/** "First Example Bank · Checking ••••4821" */
export const maskedAccount = ({ paykey }: Link) => {
  const type = paykey.accountType ? paykey.accountType[0]!.toUpperCase() + paykey.accountType.slice(1) : 'Account';
  return `${paykey.bankName} · ${type} ••••${paykey.last4}`;
};

/** Debit the linked account for the mandate. The payer name must match the sandbox identity. */
export async function debitLinked(link: Link, mandateId: string): Promise<Payment> {
  const { payment } = await post<{ payment: Payment }>(link.base, '/api/charges', {
    customerId: link.customerId,
    paykeyId: link.paykey.id,
    fullName: 'Jordan Rivera',
    agreed: true,
    scenario: link.scenario,
    metadata: { mandate_id: mandateId, chain: 'solana' },
  });
  return payment;
}

export const describeDebit = (p: Payment, link: Link) =>
  `debit ${p.chargeId}: $${(p.invoiceCents / 100).toFixed(2)} (+$${(p.feeCents / 100).toFixed(2)} fee) from ${maskedAccount(link)}, status ${p.status}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.BANK_API_BASE ?? 'http://127.0.0.1:43181';
  const [usd = '10', mandateId, scenario = 'paid'] = process.argv.slice(2);
  if (!mandateId) throw new Error('usage: start-debit.ts <amount-usd> <mandate-id> [scenario]');
  const link = await linkBank({ base, usd: Number(usd), scenario });
  const payment = await debitLinked(link, mandateId);
  console.log(describeDebit(payment, link));
}
