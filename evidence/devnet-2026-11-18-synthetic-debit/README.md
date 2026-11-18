# Devnet run 2026-11-18

Programs: identity `8LeyKvcY9XkHYt6WePMdwc8cpRHCoXsVqkXY1QJ7Q5Yo`, allowance `9BNvSF8bUEQJaBbWxBmtjRnBH1qmM47JpWWDwKM8Cs1B`, router `d85jMjdA3wUtjeD1wBuAarMMcYczSmNyWajJSxpW7UL`. Token: Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

Mandate `DXRQZcLHWy3xVo2M2heCekQbD3MnaAegrKcLrBBT7KLp` · principal `FPkWvPA3gPPY9N4onPXc3vxWpQdXLNEUYReUe6Pu5XCq` · merchant `6cEXUjWvCG24NyC71eHi3bKbVqWeQP9X5HXe1btJ7kn8` · bot `DYDC94feQzAXP3RUGHYDuiEunjWiidRuBSBxR5tgJA8T`

| # | Step | Result | Transaction |
|---|---|---|---|
| 1 | Anchor credential: principal (bank-verified) | accepted | [Z6GG4THg…](https://explorer.solana.com/tx/Z6GG4THgitH3SyQ6uGvQAtUCgBFmJ7eAxr2sFmmsTyP5voRvPRvBcvUpg4zwLkbuM78tohaMfPgVriP5bQaRXr1?cluster=devnet) |
| 2 | Anchor credential: merchant (bank-verified) | accepted | [5Ffu9mde…](https://explorer.solana.com/tx/5Ffu9mdefAWTNyQh22sVLD61nYmkY1s3evvY4VwCGTy9PM1251hXwbged8DfAton6gLGL4QF7niXgBAiFZPdBSNq?cluster=devnet) |
| 3 | Bot wallet (no credential) creates a mandate | rejected on-chain: IDENTITY_REQUIRED | [513ZN1hY…](https://explorer.solana.com/tx/513ZN1hY4eXdwtyTmma9K5RCkVGNUd6mgGWCGE8zgKiWBbb8BzwQiqJneRghXa9BTEYi8nWXpYk5wBfiPz3bKohL?cluster=devnet) |
| 4 | Mandate: $50/day, $10 per pull, 1 payee | accepted | [23pq2v4C…](https://explorer.solana.com/tx/23pq2v4CcVwnCXMt6uZntZbmFWZx26EVXEsuq6asEPCvMHCdfzh6eQxww4gRnG46hJsbL5QyF3zQ82mitgqvGb2X?cluster=devnet) |
| 5 | Agent session key issued ($50/day) | accepted | [3WVzGbYv…](https://explorer.solana.com/tx/3WVzGbYvUTzF1vtmYQhiJGKhXAWYYgzUkidJb9SRBRSRRuvWvYPeBTdRKkEnc1uuPqmyMJK9oXLHWyFLxCE3qvML?cluster=devnet) |
| 6 | Bank debit cleared: router settles 10 USDC to vault | accepted | [Uj5Pa9Up…](https://explorer.solana.com/tx/Uj5Pa9Up7Wxk1wnLbp1ABnnBiwoNXs47sxjugru717tKrGdS1fjiSVz5Grvjc9F4FsESFWoQr9UeThk2NaVVwum?cluster=devnet) |
| 7 | Pull 1: $10 USDC vault → merchant (execute_pull) | accepted | [21gG8wJz…](https://explorer.solana.com/tx/21gG8wJz1pt3q27J7tztssx7HnmARPgoqGoA7YoWeR2ANEtuvt9Fj2FUT7SVxek3D8KfeVv2rAMb5RnEn81buW7S?cluster=devnet) |
| 8 | Pull 2: $10 (authorize_pull, bank side) | accepted | [3LKKynpC…](https://explorer.solana.com/tx/3LKKynpC4rPeWRGFuTC96PxwGNUNEEDtiXyNaxFLJRybbbLYFMUy7WWo7xWJRmumNV8nrZjnHvs19yUSJ1Q9i4fz?cluster=devnet) |
| 9 | Pull 3: $10 (authorize_pull, bank side) | accepted | [3fUuCMeZ…](https://explorer.solana.com/tx/3fUuCMeZRnvRdWPKSaPYbNkozTZcvAiw4avRqfCGyd3A1hnkAwbC4oQWG7zFekm6yeg7PVeSJg1HyfmvXrQH81na?cluster=devnet) |
| 10 | Pull 4: $10 (authorize_pull, bank side) | accepted | [4EijRvvy…](https://explorer.solana.com/tx/4EijRvvyPZAMZEkDs3CNpy7NGcwC5bjaVq6MAcKm22sDrRfLWp3uD1DCtbKBagbLfBmSBboQ1eAN58BvhQRfb3rz?cluster=devnet) |
| 11 | Pull 5: $10 (authorize_pull, bank side) | accepted | [5KWnBuzc…](https://explorer.solana.com/tx/5KWnBuzcMMNqC9JvqHPAv2M3wGUo6WAGXRUbuy42me1jF25YKWFWgt85ZTLSRFJzZXUMDhiUYcH92o1ocxirDtgq?cluster=devnet) |
| 12 | Pull 6: $10, over the $50/day cap | rejected on-chain: EPOCH_CAP_EXCEEDED | [3pHoEcCb…](https://explorer.solana.com/tx/3pHoEcCbhJeddgg9qzZGEHTFDd4EoWn1sMxA1NEpsbarHK31pZwbQtYuyJgk8ujbPUokjTdFpQdmkY9VMpMBaWq8?cluster=devnet) |
| 13 | Principal revokes the mandate | accepted | [4D2MT3Jy…](https://explorer.solana.com/tx/4D2MT3Jy7uupWw3Er4Lj4TtyR52th32jo8jeMCPLvGJn3NytLu6fj8UPFukGVkbDA32rCxNnC7agvwo5qioBGmXD?cluster=devnet) |
| 14 | Pull 7: $1 after revocation | rejected on-chain: MANDATE_REVOKED | [3LEYsrWQ…](https://explorer.solana.com/tx/3LEYsrWQbGahDgMma6UQKLzF5H7Phw3zVACHPtdxoxG1BogkdDJ7mCwheTv8estPuC7xHfXPSFma6AkuSTed6pdZ?cluster=devnet) |

Merchant USDC after the run: 10
