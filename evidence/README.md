# Devnet evidence

Raw confirmed transactions (`getTransaction`, JSON) archived from Solana devnet, one file per transaction, with an index in each folder. Programs: identity `8LeyKvcY9XkHYt6WePMdwc8cpRHCoXsVqkXY1QJ7Q5Yo`, allowance `9BNvSF8bUEQJaBbWxBmtjRnBH1qmM47JpWWDwKM8Cs1B`, router `d85jMjdA3wUtjeD1wBuAarMMcYczSmNyWajJSxpW7UL`. Token: Circle devnet USDC.

| Folder | What it is |
|---|---|
| `devnet-2026-11-18-flick-debit/` | **The complete run.** A Flick open banking sandbox bank debit funds the mandate's vault through the Settlement Router, then the build-plan scenario: five $10 pulls, the sixth rejected on-chain, revoke, the seventh rejected on-chain, and a bot wallet refused. |
| `devnet-2026-11-18-synthetic-debit/` | The same scenario with a placeholder charge ID instead of a sandbox debit. |
| `devnet-2026-11-18-setup/` | Program initialisation and router float top-ups. |
| `devnet-2026-11-18-aborted-attempt/` | A run stopped by a sandbox configuration error; see its README. |

## Tying the settlement to the bank debit

The sandbox charge `chg_mock_71771164-6d3b-49a3-aeb3-0777f8f7846e` ($10.00 + $0.10 fee, First Example Bank · Checking ••••4821) cleared and its signed `paid` webhook triggered the router's `settle`. The router records each settlement under `sha256(chargeId)`, so the same debit can never settle twice:

```
sha256("chg_mock_71771164-6d3b-49a3-aeb3-0777f8f7846e")
  = 2303d147ff5e6ddfbe81d4d9e936a366289cdcad8a14c8d115895361490f9163
```

That value is the `ref_hash` in the settlement transaction's `Settled` event and the seed of its `Settlement` account (`["settlement", ref_hash]` under the router program).

The sandbox's bank leg ran on its deterministic mock (`live: false`); the HTTP contract, webhook payloads and signing are the same as with the live rail.
