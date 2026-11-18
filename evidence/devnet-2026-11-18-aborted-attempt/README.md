# Aborted attempt, 2026-11-18

The first `BANK_DEBIT=1` run stopped after the bank debit because the sandbox was started without its webhook signing secret and refused to send unsigned webhooks. These five transactions (credentials, a bot rejection, a mandate and a session key) belong to actors that run abandoned. Kept for completeness; the complete run is in `devnet-2026-11-18-flick-debit/`.
