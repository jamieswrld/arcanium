# Arch — Deployment Cost Estimate

Date: 2026-07-28. Scope: launching Arch (bridge + launchpad + gas station + web app) on Arc, testnet first, then a controlled mainnet beta. Figures are researched-or-conservative estimates in USD; on-chain figures assume Arc's stable, USDC-denominated fees and current Base fee levels.

## A. One-time costs

| Item | Low | High | Notes |
|---|---|---|---|
| Domain | $300 | $500 | Your figure (premium name). A standard `.xyz`/`.app` is $10–40/yr if you want to cut this. |
| X / Twitter | $50 | $50 | Your figure. Covers ~3–6 months of X Premium (needed for gold-check org verification it's $200/mo — not required to launch). |
| Testnet deployment (Base Sepolia + Arc testnet) | $0 | $0 | Faucet-funded. Circle faucet for Arc testnet USDC + Base Sepolia USDC; public faucets for Base Sepolia ETH. |
| Mainnet contract deployment — Base side | $2 | $10 | One vault contract (~2.5M gas) + config txs on Base mainnet at typical sub-cent-per-100k-gas levels. |
| Mainnet contract deployment — Arc side | $5 | $50 | ~8 contracts + Uniswap pool interactions ≈ 20–30M gas total. Arc fees are USDC-stable and designed to be low; range is padded because Arc mainnet fee levels aren't publicly final. |
| Contract verification, ENS-style niceties | $0 | $20 | Explorer verification is free. |
| Logo/brand assets | $0 | $150 | DIY vs. one-off commission. |
| **Subtotal (no audit)** | **≈ $360** | **≈ $780** | |

## B. Security (the honest line items)

The vault holds user USDC. Launching mainnet without any independent review is how bridges die.

| Tier | Cost | What you get |
|---|---|---|
| Minimum viable | $3,000 – $8,000 | One independent senior Solidity reviewer, 1–2 weeks, focused on the vault/bridge/liquidity-lock invariants. |
| Standard | $15,000 – $40,000 | Small established firm, full-scope audit + fix review. |
| Belt and braces | +$10,000+ | Competitive audit (Sherlock/Code4rena) or second firm, plus funded bug bounty. |
| Deferral strategy | $0 now | Launch mainnet in "capped beta": deposit cap (e.g. $100 max), aggressive release caps, pause drills — while the audit runs. Caps are already built into the contracts. |

Recommendation for a viable path: **capped beta at launch + minimum-viable review (~$3–8k) as revenue appears**, with the 15% deposit fee itself funding the standard audit later.

## C. Recurring monthly costs

| Item | Low | High | Notes |
|---|---|---|---|
| Vercel (web app) | $0 | $20 | Hobby tier works for beta; Pro ($20/seat) for a commercial product. |
| Workers + API + indexer host | $10 | $30 | One small VPS (Hetzner/Fly/Railway) runs all six Node services comfortably at beta scale. |
| PostgreSQL | $0 | $25 | Neon/Supabase free tier at beta; ~$25 managed production tier. |
| Redis | $0 | $10 | Upstash free tier at beta. |
| RPC (Base + Arc) | $0 | $49 | Public endpoints + free tiers (Alchemy/QuickNode/thirdweb) are fine at beta volume; first paid tier if traffic grows. |
| Image/metadata storage (R2/S3) | $0 | $5 | Cloudflare R2 free tier covers beta. |
| Monitoring/logs | $0 | $10 | Grafana Cloud / Axiom free tiers. |
| Email/misc SaaS | $0 | $12 | Optional. |
| **Subtotal** | **≈ $10/mo** | **≈ $160/mo** | Realistic beta: **$30–60/mo**. |

## D. Operational float (recoverable working capital, not spend)

| Item | Amount | Purpose |
|---|---|---|
| Gas-station inventory (native USDC on Arc) | $200 – $500 | The stock the gas station sells for aUSD. Recycled + 5% margin; refill as needed. |
| Arc keeper/relayer gas float | $50 | Native USDC for mint/drip transactions. |
| Base keeper gas float | $25 – $50 | ETH on Base for release transactions. |
| **Float total** | **≈ $275 – $600** | Comes back as fees/margin; not consumed. |

Note: the bridge reserve itself needs **zero** capital from you — it is user deposits by construction, and the 15% entry fee accrues to the treasury from the first deposit.

## E. Totals

| Scenario | Upfront | Monthly | Float |
|---|---|---|---|
| **Testnet + Vercel beta (start here)** | $350 – $550 (domain + X only) | $0 – $20 | $0 (faucets) |
| **Mainnet capped beta, audit deferred** | $400 – $800 | $30 – $60 | $275 – $600 |
| **Mainnet with minimum-viable review** | $3,400 – $8,800 | $30 – $60 | $275 – $600 |
| **Mainnet, standard audit** | $15,400 – $40,800 | $50 – $160 | $600 |

## F. What the fees earn back (context)

At Envelope-parity activity: every $1,000 bridged in earns Arch $150 (15% entry fee); every launch earns 52.5 aUSD (~$52.50); Arch takes 70% of the 1% quote-side pool fees on all trading volume, plus a 5% gas-station margin. A single moderately active launch day can cover a month of infrastructure.

## G. Explicit exclusions

Legal/regulatory review (jurisdiction-dependent; a bridged-dollar issuer should get real advice before mainnet), paid marketing, artificial engagement (never), Arc mainnet parameters (unconfirmed — see ADR 0006; mainnet spend cannot happen until the official address book is verified).
