# Milestones 4–9 — delivered 2026-07-29 (testnet-live)

Consolidated report. Commands: `forge test` (packages/contracts) → 81/81; `pnpm build` → 14/14; production site https://arclaunchpad-eight.vercel.app.

## M4 — Gas station ✅ (live E2E)

`ArchGasStation.sol` (never-sells-below-par pricing, per-action caps, cooldown, relayer-only, pause, 5% visible margin, permit-tolerant retries; cooldown first-drip bug caught by tests). Deployed `0x153B…1C29` with 5 USDC inventory. Relayer as server-side Vercel routes (`/api/gas/quote`, `/api/gas/drip`, RPC fallback rotation after the official Arc RPC blocked Vercel egress). Live E2E: quote 0.0115 USDC ↔ 0.012075 aUSD → permit → drip confirmed `0xf4b6…1116`. Gas page wired.

## M5 — Launchpad ✅ (live launch executed)

Official Uniswap v3 deployed to Arc testnet (factory `0xbe4b…0740`, NPM `0x26cc…79af`, router `0x3628…7248`; 1% tier). Arch contracts: `ArchLaunchToken` (fixed 1B/18d, nothing else), `ArchLaunchpadFactory` (atomic token+pool+lock+creator-buy; exact hardcoded sqrtPrice/tick constants both orderings; residual-dust burn with 0.0001% guard), `ArchLiquidityVault` (custody via `ownerOf` — NPM mints without ERC721 callback; collect-only; narrow migration authority), `ArchFeeDistributor` (burn token side; 30/70 quote side; permissionless + batch; 10–50% compiled bounds), `GraduationRegistry` (permanent 9,000-unit label). Integration tests run against real Uniswap bytecode (vendored artifacts + `deployCode`): both orderings, $3k start price via first-buy bounds, price up/down mechanics, exact 30/70, lock unbreakability, graduation permanence, full supply accounting. Deployed: vault `0xaae5…264c`, factory `0xcc39…64f9`, distributor `0xb1aa…35c0`, graduation `0x8e8b…AE86`. **Live launch: ARCHIE** `0x0D40…7d00` (pool `0xE463…3441`, position #1, creator buy 3 aUSD → ~979k tokens at the expected price).

Fee routing per owner directive: `ArchFeeSplitter` (40% / 6×10%, permissionless flush, ERC-20 + native) deployed on **both chains** (Arc `0x9d98…34f7`, Base `0x153b…1c29`); vault bridge fees, launch fees, and the 70% protocol share all point at it. 7 recipient wallets generated → keys in git-ignored `.wallets.testnet.json` (testnet-only; owner regenerates for mainnet and rotates via `setRecipients`).

## M6/M7 — Token data + launchpad frontend ✅

Frontend is chain-backed (persistent Postgres indexer is the remaining M9 op): discovery with URL-param sort/search pills, live price/mcap via exact bigint sqrtPriceX96 math (both orderings), graduation progress; create page does the real atomic launch (live fee read, validation, metadata as data-URI pending S3, decode Launched → redirect); token page (identity header, market stats, TradePanel via standard router with simulate-then-bound slippage, MarketPanels chart+trades from real Swap logs over a bounded window). Envelope token-page screenshots absorbed into parity report §8.4 (incl. the emergent ~6% LP share note — reproduced automatically by identical launch parameters).

## M8 — Migration ✅ (tests prove value neutrality)

`AusdExchange` (opens only fully collateralized; permanent; no deadline; burns aUSD 1:1 for USDC) and `PoolMigrator` (vault authority path → 1:1 exchange → recreate pool at identical effective price with mirrored range if ordering flips → relock in vault; dust burned/returned). Tests: cannot-open-underwater, 10-year-later exchange, price/token/quote preservation within 0.1% (after the runbook's distribute-first step — uncollected fees belong to the split, not principal), authority-only and owner-only paths, one-shot per pool.

## M9 — Hardening (docs delivered; ops itemized)

`docs/ops/mainnet-readiness.md` — the full gate checklist and mainnet-day order. Deferred ops (itemized there): VPS for workers/API/indexer, Postgres-backed indexer for full history + holders tab, timelock+multisig wiring, monitoring/alerting, S3 image uploads, WalletConnect project id, audit.

## Known divergences added this session

- Metadata URI is a base64 data URI on testnet (S3/IPFS for mainnet).
- Trades/chart window is bounded by public-RPC limits until the indexer lands.
- Testnet launch fee 5 aUSD (mainnet 52.5); testnet min deposit 1 USDC (mainnet 25).
- Envelope's percent-chip buy amounts and gas-estimate row in the trade panel: to add in the polish pass alongside shadcn restyle.
