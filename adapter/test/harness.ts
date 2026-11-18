import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSigner, lamports, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { LiteSVM } from 'litesvm';
import type { ConformanceHarness } from '@openfi/chain-conformance';
import { SolanaChainAdapter } from '../src/adapter.js';
import { getInitConfigInstruction, OPENFI_ALLOWANCE_PROGRAM_ADDRESS } from '../src/generated/allowance/index.js';
import { getInitRegistryInstruction, OPENFI_IDENTITY_PROGRAM_ADDRESS } from '../src/generated/identity/index.js';
import { getInitRouterInstruction, OPENFI_ROUTER_PROGRAM_ADDRESS } from '../src/generated/router/index.js';
import { LiteSvmTransport } from '../src/litesvm-transport.js';
import { allowancePdas, identityPdas, routerPdas } from '../src/pdas.js';

const deploy = (name: string) => fileURLToPath(new URL(`../../target/deploy/${name}.so`, import.meta.url));

/**
 * A fresh in-process cluster with the three programs deployed, a 6-decimal
 * test USDC mint, and the registry, allowance config and router initialised
 * with one OpenFi executor key in every operator role.
 */
export async function createLiteSvmHarness(): Promise<
  ConformanceHarness & {
    adapter: SolanaChainAdapter;
    transport: LiteSvmTransport;
    executor: TransactionSigner;
    mint: Address;
    signerOf: (address: string) => TransactionSigner;
    tokenBalance: (tokenAccount: Address) => Promise<bigint>;
    fundWallet: (owner: string, amount: bigint) => Promise<void>;
  }
> {
  const svm = new LiteSVM().withPrecompiles();
  svm.addProgramFromFile(OPENFI_IDENTITY_PROGRAM_ADDRESS, deploy('openfi_identity'));
  svm.addProgramFromFile(OPENFI_ALLOWANCE_PROGRAM_ADDRESS, deploy('openfi_allowance'));
  svm.addProgramFromFile(OPENFI_ROUTER_PROGRAM_ADDRESS, deploy('openfi_router'));
  // Start the clock somewhere realistic; LiteSVM begins at 0.
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000));
  svm.setClock(clock);

  const transport = new LiteSvmTransport(svm);
  const executor = await generateKeyPairSigner();
  svm.airdrop(executor.address, lamports(1_000_000_000_000n));
  const send = (ixs: Instruction[]) => transport.send(ixs, [executor]);

  const mint = await generateKeyPairSigner();
  await send([
    getCreateAccountInstruction({
      payer: executor,
      newAccount: mint,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(getMintSize()))),
      space: getMintSize(),
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: executor.address }),
  ]);
  await send([
    getInitRegistryInstruction({ admin: executor, registry: identityPdas.registry(), issuer: executor.address }),
    getInitConfigInstruction({ admin: executor, config: allowancePdas.config(), operator: executor.address }),
    getInitRouterInstruction({
      admin: executor,
      config: routerPdas.config(),
      mint: mint.address,
      inventory: routerPdas.inventory(),
      authority: executor.address,
    }),
  ]);

  const wallets = new Map<string, TransactionSigner>();
  const adapter = new SolanaChainAdapter({
    transport,
    executor,
    mint: mint.address,
    signerFor: (a) => wallets.get(a),
  });

  const ata = async (owner: Address) => (await findAssociatedTokenPda({ owner, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const mintTo = (account: Address, amount: bigint) =>
    send([getMintToInstruction({ mint: mint.address, token: account, mintAuthority: executor, amount })]);

  return {
    adapter,
    transport,
    executor,
    mint: mint.address,
    signerOf: (a) => wallets.get(a)!,
    async tokenBalance(account) {
      const acc = await transport.getAccount(account);
      return acc ? getTokenDecoder().decode(acc.data).amount : 0n;
    },
    async fundWallet(owner, amount) {
      await mintTo(await ata(owner as Address), amount);
    },
    async newWallet() {
      const w = await generateKeyPairSigner();
      wallets.set(w.address, w);
      // Wallets hold no SOL: the executor pays for their token account.
      await send([
        getCreateAssociatedTokenIdempotentInstruction({
          payer: executor,
          ata: await ata(w.address),
          owner: w.address,
          mint: mint.address,
        }),
      ]);
      return { address: w.address, did: `did:pkh:${adapter.chainId}:${w.address}` };
    },
    async fundVault(mandateId, amount) {
      await mintTo(allowancePdas.vault(allowancePdas.mandate(mandateId)), amount);
    },
    async fundRouter(amount) {
      await mintTo(routerPdas.inventory(), amount);
    },
    async balanceOf(address) {
      const acc = await transport.getAccount(await ata(address as Address));
      return acc ? getTokenDecoder().decode(acc.data).amount : 0n;
    },
    now: () => transport.now(),
    async advanceTime(seconds) {
      transport.advanceTime(seconds);
    },
  };
}

export const randomRef = () => randomBytes(8).toString('hex');
