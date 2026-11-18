# Devnet run 2026-11-18

Programs: identity `8LeyKvcY9XkHYt6WePMdwc8cpRHCoXsVqkXY1QJ7Q5Yo`, allowance `9BNvSF8bUEQJaBbWxBmtjRnBH1qmM47JpWWDwKM8Cs1B`, router `d85jMjdA3wUtjeD1wBuAarMMcYczSmNyWajJSxpW7UL`. Token: Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

Mandate `6qj92znyD55YUGKTBXmSpHc9RmasV7PtcUtMPw5yp6SU` · principal `5z1aujggu82K6ZxotDdghiK5pcixuKSunv8GLCnCbH1Y` · merchant `G6ErqLHvJCxsASuRJr1yRtkP91weBdUVVB6NwK8nckTz` · bot `2vBgher1XcYohPf3nQwEHVWYCAQ795kbzhAyS7oALnsf`

| # | Step | Result | Transaction |
|---|---|---|---|
| 1 | Anchor credential: principal (bank-verified) | accepted | [7tw9mRXW…](https://explorer.solana.com/tx/7tw9mRXWAc9vZMHs5KsE6Lk1JzD1RrQ2pVNVaz8yGjXJDpXTtuPDZcMnbcn61cTn5Pe97LpricEfLH3HvV674MT?cluster=devnet) |
| 2 | Anchor credential: merchant (bank-verified) | accepted | [5HhXQySb…](https://explorer.solana.com/tx/5HhXQySbGriWev3rsF2swEbpJzPPfrMdnqmH2Me8CsQJFcjeLKqDWoxDvoAdU6BL8FgbvpoM6f7nV1VreKAZcQpB?cluster=devnet) |
| 3 | Bot wallet (no credential) creates a mandate | rejected on-chain: IDENTITY_REQUIRED | [3PfpHuv5…](https://explorer.solana.com/tx/3PfpHuv5W5FFhjeg1b2egjhuiiBDHeHkpqcYMPAu8mSRRFpM1z14iJ4Vu8Ht3AFD7A9QQM7azScC18TBenyJyoNz?cluster=devnet) |
| 4 | Mandate: $50/day, $10 per pull, 1 payee | accepted | [2fvWrfrB…](https://explorer.solana.com/tx/2fvWrfrBwiQi87PgPMZRRjJjuBgFZ996jAK52AXgj7nFgqCxoqUikBCeJiqtY714pEF8QVAjjKuTE1yn8h62qnaH?cluster=devnet) |
| 5 | Agent session key issued ($50/day) | accepted | [4yMDuS5o…](https://explorer.solana.com/tx/4yMDuS5ocoXvkhUjAxDGjZoAtyL3ZT49jYqJhJXq5pAiTmaXjgV57YE3mTGrSpBLFMrVmW5jtV4pgZo74tGYDR24?cluster=devnet) |
| 6 | Bank debit chg_mock_71771164-6d3b-49a3-aeb3-0777f8f7846e cleared: router settles 10 USDC to vault | accepted | [4UoFtizf…](https://explorer.solana.com/tx/4UoFtizfnDD4tdPpAfEdAXSfrQy97fLeN6t8YDervi3u3XGT7vSY2SWwmHPc4vBSkYV5q2cYkiFTEGWSNBo31Yk7?cluster=devnet) |
| 7 | Pull 1: $10 USDC vault → merchant (execute_pull) | accepted | [4Ecos3aE…](https://explorer.solana.com/tx/4Ecos3aE4P2Q3YgvHVQeBxoyvLwrHbucJXzcZ1AwkLzbEeoCkbT2UL3rQqicxVGDHazGRvdsTraGSxVRhzSVPQpV?cluster=devnet) |
| 8 | Pull 2: $10 (authorize_pull, bank side) | accepted | [aBRGqPf3…](https://explorer.solana.com/tx/aBRGqPf3SbmfziLPq3yqaA8CsBpKz6Ck73jAcDgu6vDjaVu4PGU83MFR5TiHdiXXxtdH56N9kikDEYgJz2Bdoup?cluster=devnet) |
| 9 | Pull 3: $10 (authorize_pull, bank side) | accepted | [8k1guYxp…](https://explorer.solana.com/tx/8k1guYxpdwZDgjnnjrbjH4udFmv9CmZN3Ux3yzVkALDxSRNs15y5XyL2aB41GPWoqdyaN3VFM3apmYFhzBTowqz?cluster=devnet) |
| 10 | Pull 4: $10 (authorize_pull, bank side) | accepted | [5fa8WbJE…](https://explorer.solana.com/tx/5fa8WbJEUbPsPQUe6hYJ24kXLMeE26LMHymZAbB3ezQn1GJ9VmZF7M6AezBGmf6mUcQakbe15PXYee1NDgm45Gq3?cluster=devnet) |
| 11 | Pull 5: $10 (authorize_pull, bank side) | accepted | [2vZzTqgy…](https://explorer.solana.com/tx/2vZzTqgyyuP5vWERnZCQDPUt7ttAe2NfpmWaToFGs45MaXeJsbYKuc4kieq3LNMN5tpfEZMxNSCXvokhcwXiisQJ?cluster=devnet) |
| 12 | Pull 6: $10, over the $50/day cap | rejected on-chain: EPOCH_CAP_EXCEEDED | [ru4e78ea…](https://explorer.solana.com/tx/ru4e78eatxXfBa2UofTA7R4fqUkxZLFwkarfgX4sWs53bYVDVciTyqjoRvoUhBz2GNJfzBuJQX4a5L2tN65knbm?cluster=devnet) |
| 13 | Principal revokes the mandate | accepted | [WX5Jd1DV…](https://explorer.solana.com/tx/WX5Jd1DV9RcETm2BkTYMFa5CoUkVy2XQMAFcPC5yxxDnj27a438Rf7Jf8biPXjhCYgwDLLeKxrCLGV29RV5wo7A?cluster=devnet) |
| 14 | Pull 7: $1 after revocation | rejected on-chain: MANDATE_REVOKED | [5XWyygU4…](https://explorer.solana.com/tx/5XWyygU4Ngq3HsNPGrawuH81NkzmQf1ZQCcTgryLo5vuS7V1qri7y1ZBiA8FXFuZev51sSA77y9FdjnxSqu2bYFU?cluster=devnet) |

Merchant USDC after the run: 10
