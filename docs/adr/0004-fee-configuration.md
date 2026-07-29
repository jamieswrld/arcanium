# ADR 0004 — Fee configuration and divergences from Envelope

Status: Accepted · Date: 2026-07-28

## Decision

| Fee | Arch value | Envelope verified value | Divergence |
|---|---|---|---|
| Bridge deposit fee | 1500 bps (15%) | 1000 bps (10%, `feeBps()` on-chain) | Mandated |
| Bridge redemption fee | 0 (free, 1:1) | free, 1:1 | Parity |
| Quote-side LP fee split | 3000 bps creator / 7000 bps protocol | 3500/6500 (`creatorFeeBps()` on-chain) | Mandated |
| Token-side LP fees | 100% burned | 100% burned | Parity |
| Gas-station margin | 500 bps visible margin over measured cost | undisclosed | Arch discloses |
| Uniswap pool fee | 10000 (1% tier) | 10000 | Parity |
| Launch fee | 52,500,000 quote units (52.5 aUSD/USDC) = 105% of Envelope's on-chain 50,000,000 | 50 quote units (`launchFee()` on-chain, 2026-07-28) | Mandated formula |

## Rules

- Contracts store fees; the frontend and API always read them live (`feeBps()`-style getters). No hardcoded fee values outside deployment scripts and env defaults.
- Every fee change goes through the timelocked protocol multisig and emits an event; hard caps in contracts bound each fee (e.g. deposit fee can never exceed a compiled-in maximum) so even the multisig cannot make fees confiscatory.
- Every user-facing fee appears: before wallet confirmation, in the review, in the receipt, in history, and in public docs. No hidden fees; no router tax.
- All values are exposed via `packages/config` as bigint-safe integers (bps or raw units), never floats.
