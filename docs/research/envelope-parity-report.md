# Envelope Parity Report

Research date: 2026-07-28.
Purpose: document Envelope's product mechanics, routes, states, contracts, and APIs so Arch can reproduce them as an original clean-room implementation. Every item carries a verification status:

- `VERIFIED_FROM_DOCS` — stated in Envelope's public documentation (envelope.trade/docs).
- `VERIFIED_ONCHAIN` — read directly from deployed Envelope contracts via public RPC on 2026-07-28.
- `VERIFIED_IN_UI` — observed in the rendered Envelope application.
- `INFERRED` — reasonable deduction from surrounding evidence; not directly observed.
- `UNKNOWN` — could not be verified; Arch implements the safest reasonable version and records the assumption.

No Envelope source code, CSS, images, private APIs, or proprietary frontend code were copied. Research inputs were: public documentation pages, the publicly served application shell, public RPC reads of deployed contracts, and publicly served static configuration (RPC URL discovery only — no code reuse).

---

## 1. Networks and deployed contracts

| Item | Value | Status |
|---|---|---|
| Envelope Base-side network | Base mainnet (uses canonical Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) | VERIFIED_FROM_DOCS + VERIFIED_ONCHAIN |
| Envelope Arc-side chain ID | `5042` (`0x13b2`) — confirmed via `eth_chainId` on the RPC endpoint Envelope's frontend uses (`https://5042.rpc.thirdweb.com`) | VERIFIED_ONCHAIN |
| Official Circle/Arc confirmation of chain 5042 as "Arc mainnet" | Official Arc docs (docs.arc.io) as fetched still describe Arc as "available on Testnet only" (content may be cached/stale). Third-party sources conflict (5042 vs 1243). | UNKNOWN — Arch keeps `arcMainnet` fully env-driven and gated by `ENABLE_ARC_MAINNET=false` |
| Arc testnet chain ID | `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`, CCTP domain 26 | VERIFIED_FROM_DOCS (Circle's official skills repo + Arc docs) |
| Arc native gas | USDC is the native gas asset. Native view uses 18 decimals (`msg.value`, gas), ERC-20 view uses 6 decimals; both views expose the same underlying balance (USDC precompile at `0x3600000000000000000000000000000000000000`) | VERIFIED_FROM_DOCS (Circle) + VERIFIED_ONCHAIN (factory `usdc()` returns `0x3600…0000` on chain 5042) |
| Envelope Vault (Base) | `0x01a29660520C693615A62382603a4cAC7ffD4A15` | VERIFIED_FROM_DOCS (address page) + VERIFIED_ONCHAIN (live state reads) |
| eUSD token (Arc) | `0x01a29660520C693615A62382603a4cAC7ffD4A15` (same address as the Base vault — same deployer/nonce) | VERIFIED_FROM_DOCS + VERIFIED_ONCHAIN |
| Envelope Bridge (Arc) | `0x5A9C82C01e48D986F15A51ECEdcB3c74078BEC7a` | VERIFIED_FROM_DOCS |
| Launchpad Factory (Arc) | `0x3B16d559bacf9854504794CF60c5Ff2Ab67d9C81` | VERIFIED_FROM_DOCS + VERIFIED_ONCHAIN |
| Uniswap v3 NonfungiblePositionManager (Arc 5042) | `0x39654A85a4C05127F5fD6ED22CaEc077A0FB1377` (factory `positionManager()`) | VERIFIED_ONCHAIN |
| Uniswap v3 SwapRouter (Arc 5042) | `0x4C91C54e60b59B1f949AF57064eA70bd73434720` (factory `swapRouter()`) | VERIFIED_ONCHAIN |
| Arc explorer used by Envelope | `https://arc.exploreme.pro` (custom Next.js explorer, not Blockscout) | VERIFIED_FROM_DOCS |
| Envelope factory implementation pattern | Factory runtime bytecode begins `0x60806040527f360894a13ba1…` (embeds the EIP-1967 implementation-slot constant) → the factory itself appears to sit behind a proxy, even though docs state launched tokens/pools have "no proxy" | VERIFIED_ONCHAIN (bytecode) / INFERRED (interpretation). **Arch divergence: Arch uses no upgradeable proxies anywhere, per coding rules.** |

## 2. eUSD token (Arch analog: aUSD)

| Item | Value | Status |
|---|---|---|
| Name | `Envelope USD` | VERIFIED_ONCHAIN |
| Symbol | `EUSD` | VERIFIED_ONCHAIN |
| Decimals | `6` | VERIFIED_ONCHAIN + VERIFIED_FROM_DOCS |
| Total supply (2026-07-28) | `276,652.554973` eUSD (`0x4082f7fadd` raw) | VERIFIED_ONCHAIN |
| Backing | "USDC on Base becomes eUSD on Arc, backed one for one." Reserve invariant: "the USDC reserve on Base always covers the eUSD supply on Arc" | VERIFIED_FROM_DOCS |
| EIP-2612 permit support | Required by the gas-station flow ("Sign EIP-2612 Permit … Signing costs no gas") | VERIFIED_FROM_DOCS |
| Issuer disclosure | eUSD is a third-party token issued by Envelope, not Circle | VERIFIED_FROM_DOCS |

## 3. Bridge mechanics

| Item | Value | Status |
|---|---|---|
| Deposit flow | USDC locked in the Base vault as reserve; eUSD minted to the recipient on Arc | VERIFIED_FROM_DOCS |
| Deposit function | `EnvelopeVault.deposit(uint256 amount, address recipient)` after `IERC20(USDC).approve(vault, amount)`; recipient need not be the sender | VERIFIED_FROM_DOCS |
| Deposit fee | `feeBps() = 1000` → **10%**, taken from `amount` inside the deposit transaction; user receives `amount − fee` in eUSD | VERIFIED_ONCHAIN (value) + VERIFIED_FROM_DOCS (mechanics). **Arch divergence: 15% (`BRIDGE_DEPOSIT_FEE_BPS=1500`) per product mandate.** |
| Min deposit | `minDeposit() = 25 USDC` (25,000,000 raw) | VERIFIED_ONCHAIN |
| Max deposit | `maxDeposit() = 100,000 USDC` (100,000,000,000 raw) | VERIFIED_ONCHAIN |
| Redemption function | `EnvelopeBridgeArc.redeem(uint256 amount, address baseRecipient)`; burns eUSD first; "Only after that burn is confirmed does the vault release USDC to you on Base" | VERIFIED_FROM_DOCS |
| Redemption fee | "Redeeming back to USDC is free and exactly one for one" | VERIFIED_FROM_DOCS |
| Min redeem | `minRedeem()` getter exists; live value not read (Arc bridge contract getter list unverified) | VERIFIED_FROM_DOCS (getter) / UNKNOWN (value) |
| Settlement time | "Transfers settle in about a minute" / UI: "Estimated time ≈1 min" | VERIFIED_FROM_DOCS + VERIFIED_IN_UI |
| Reorg policy | "The bridge waits for your deposit or burn to be several blocks deep before acting, so a chain reorganisation cannot lose or duplicate a transfer." Exact confirmation counts not published | VERIFIED_FROM_DOCS (policy) / UNKNOWN (counts). Arch: configurable confirmation depth per chain, defaults conservative |
| Rate caps | Contracts "cap how much can be minted or released in a single transaction or block" | VERIFIED_FROM_DOCS |
| Reserve movement | "The reserve can only be moved by a publicly visible on-chain migration, which requires deposits and releases to be paused first" | VERIFIED_FROM_DOCS |
| Live fee reading | "The fee and the minimum amounts can change, so the bridge screen reads them live from the contracts" | VERIFIED_FROM_DOCS — Arch frontend must also read fees live |
| Deposit event | `event Deposited(address indexed sender, address indexed recipient, uint256 netAmount, uint256 feeAmount)` as documented. No gross amount or nonce field documented | VERIFIED_FROM_DOCS. **Arch divergence: Arch's event also carries gross amount and nonce (superset, per spec).** |
| Action ID derivation | `keccak256(abi.encode(txHash, logIndex))` of the originating event | VERIFIED_FROM_DOCS |
| Bridge status API | `GET https://api.envelope.trade/bridge-api/api/deposit/{actionId}`, `GET …/bridge-api/api/burn/{actionId}` | VERIFIED_FROM_DOCS |
| Bridge status response shape | Field-level shape not published | UNKNOWN — Arch defines its own state machine (documented in the API spec) |

## 4. Gas station

| Item | Value | Status |
|---|---|---|
| Problem/solution | "Arc charges gas in native USDC. The gas station sells a small amount of it for eUSD, so a wallet holding only bridged eUSD can still transact." Relayer submits and covers gas | VERIFIED_FROM_DOCS |
| Action IDs | `0` = swap, `1` = launch | VERIFIED_FROM_DOCS. **Arch divergence: adds `2` = redemption, `3` = approval (superset, per spec).** |
| Quote API | `POST https://api.envelope.trade/gas-relayer/api/gas/quote` with `{"action_id": 0}`; response includes native gas amount (wei), eUSD cost (6 decimals), gas price, token address, chain ID | VERIFIED_FROM_DOCS |
| On-chain quote | `quote(uint256 actionId, uint256 gasPrice)` | VERIFIED_FROM_DOCS |
| Permit | EIP-2612 typed signature for exactly the quoted eUSD amount; signing costs no gas | VERIFIED_FROM_DOCS |
| Drip API | `POST …/gas-relayer/api/gas/drip` with user address, action ID, native amount, deadline, signature components; responds with tx hash and status `confirmed` or `submitted` | VERIFIED_FROM_DOCS |
| Protections | Direct `drip()` calls blocked on-chain; per-action cap; priced off live gas price; in-flight duplicate permit returns HTTP 409 | VERIFIED_FROM_DOCS |
| Service margin | Envelope's margin over gas cost is not published | UNKNOWN — Arch uses its mandated visible 5% margin (`GAS_STATION_MARGIN_BPS=500`) |
| Rate limiting specifics | Not published | UNKNOWN — Arch implements per-user rate limits (documented in gas-station spec) |

## 5. Launchpad mechanics

| Item | Value | Status |
|---|---|---|
| Supply | Fixed 1,000,000,000 tokens, 18 decimals, minted once into a Uniswap v3 pool | VERIFIED_FROM_DOCS |
| Market model | "There is no custom AMM, no bonding curve, and no proxy." No pre-graduation market; trades on Uniswap v3 from launch | VERIFIED_FROM_DOCS |
| Fee tier | Standard Uniswap v3 1% tier (`fee = 10000`) | VERIFIED_FROM_DOCS |
| Pair choice | Creator chooses USDC or eUSD as the quote token | VERIFIED_FROM_DOCS |
| Launch fee | `launchFee() = 50,000,000` raw = **50 quote units (6 decimals)** | VERIFIED_ONCHAIN. **Arch: 105% → `LAUNCH_FEE_QUOTE_UNITS=52500000` (52.5 aUSD).** |
| Starting market cap | "roughly a $3,000 starting market cap" → ≈ $0.000003/token | VERIFIED_FROM_DOCS |
| Launch position | "The supply launches as a single-sided position, the price rises as people buy and falls as they sell" | VERIFIED_FROM_DOCS |
| Liquidity lock | The launch position "can never be withdrawn, so the liquidity cannot be pulled out from under the pool" | VERIFIED_FROM_DOCS |
| Graduation threshold | "$9,000 pool balance" → permanent UI label; "does not change the token, unlock liquidity, or create a new market" | VERIFIED_FROM_DOCS |
| Graduation reversal | Label is permanent | VERIFIED_FROM_DOCS |
| Token-side LP fees | "100% burned, reducing supply" | VERIFIED_FROM_DOCS |
| Quote-side LP fees | "35% to the token creator, 65% to the platform" — confirmed on-chain: `creatorFeeBps() = 3500` | VERIFIED_FROM_DOCS + VERIFIED_ONCHAIN. **Arch divergence: 30/70 (`PAIR_FEE_CREATOR_SHARE_BPS=3000`, `PAIR_FEE_PROTOCOL_SHARE_BPS=7000`) per product mandate.** |
| Fee distribution trigger | "Anyone can trigger a fee distribution"; "the recipients are fixed, so creator rewards keep accruing for the life of the pool" | VERIFIED_FROM_DOCS |
| Creator initial purchase at launch | Not mentioned anywhere in Envelope docs or observed UI | UNKNOWN — Arch implements optional atomic creator buy per its own spec (`creatorBuyAmount`, `minTokensOut`, `deadline`) and records this as an Arch feature, not verified Envelope parity |
| Launched event | `event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId)` — no metadataUri field documented | VERIFIED_FROM_DOCS. **Arch divergence: adds `string metadataUri` (superset, per spec).** |
| Token ordering | "token0 and token1 sort by address, so the launched token is not always token1" | VERIFIED_FROM_DOCS |
| Metadata fields | Name, ticker, image, optional description and socials | VERIFIED_FROM_DOCS (launch form description) |
| Metadata storage | Where Envelope stores images/metadata is not published | UNKNOWN — Arch uses content-addressed/immutable storage with sanitization per spec |

## 6. eUSD → USDC migration (wind-down)

| Item | Value | Status |
|---|---|---|
| Trigger | Circle operating its own USDC bridge to Arc | VERIFIED_FROM_DOCS |
| Sequence | New deposits close → USDC backing moves to Arc → 1:1 exchange opens; "eUSD is exchanged for native USDC one for one and Envelope stops issuing new eUSD" | VERIFIED_FROM_DOCS |
| Solvency gate | "The exchange cannot open underwater" — USDC on hand must fully cover all outstanding eUSD | VERIFIED_FROM_DOCS |
| Deadline | None — holders can redeem at any time | VERIFIED_FROM_DOCS |
| Pool migration | Liquidity withdrawn → eUSD exchanged 1:1 → identical pool recreated with same pricing and token amounts; "Nothing about the value of your position changes"; creator fees continue in USDC; USDC-paired pools skip migration | VERIFIED_FROM_DOCS |
| Factory pairToken update | `pairToken` on the factory updates during migration; indexers must read it live | VERIFIED_FROM_DOCS |
| Migration authorization details | Who can invoke, timelocks, exact route for moving reserve to Arc | UNKNOWN — Arch designs a narrow, auditable, multisig+timelock path and documents it |

## 7. Indexing and pricing

| Item | Value | Status |
|---|---|---|
| Price formula (documented) | `P = (Number(sqrtPriceX96) / 2**96)**2; tokensPerQuote = P * 1e6 / 1e18; priceUsd = 1 / tokensPerQuote; marketCap = priceUsd * 1e9` — note Envelope's own docs demonstrate JS `Number` math | VERIFIED_FROM_DOCS. **Arch divergence: exact bigint math only (coding rule); the JS-Number example is reproduced for reference, never for computation.** |
| Dollar convention | "Treat eUSD as $1. It is backed one for one by USDC" — no oracle | VERIFIED_FROM_DOCS |
| Token list API | `GET https://api.envelope.trade/launchpad-api/api/launchpad/tokens?sort=age&limit=100` | VERIFIED_FROM_DOCS |
| Token detail API | `GET …/launchpad-api/api/launchpad/tokens/{token}` | VERIFIED_FROM_DOCS |
| Candles API | `GET …/launchpad-api/api/launchpad/tokens/{token}/candles?interval=5m` | VERIFIED_FROM_DOCS |
| Response fields | `marketcap_usd`, `liquidity_usd`, `volume_24h_usd`, `change_24h_pct` | VERIFIED_FROM_DOCS |
| Full sort options | Only `sort=age` observed | INFERRED for the rest — Arch implements its own full sort set (`newest`, `oldest`, `market_cap`, `volume_24h`, `liquidity`, `price_change`, `graduating`, `graduated`) |
| Candle intervals | `5m` verified in example; full interval list unpublished | INFERRED — Arch implements `1m 5m 15m 1h 4h 1d` per its spec |
| Trades/holders/rewards endpoints | Not documented | UNKNOWN — Arch defines its own (`/trades`, `/holders`, `/rewards`) |

## 8. Application routes and UI

### 8.1 Routes and navigation

| Item | Observation | Status |
|---|---|---|
| Default route `/` | Opens the Bridge | VERIFIED_IN_UI |
| Navigation tabs | Bridge, Create, Tokens, Portfolio, Gas, Docs; Discord and X icons; Connect wallet button | VERIFIED_IN_UI |
| `/tokens` | Token discovery (invalid-address error state observed: "That address isn't a token on Arc" with "Browse tokens" action) | VERIFIED_IN_UI (route + error state) / INFERRED (full listing layout — SPA content not server-rendered) |
| `/docs` and subpages | `/docs`, `/docs/bridge`, `/docs/bridge/fees`, `/docs/bridge/wind-down`, `/docs/launchpad`, `/docs/launchpad/economics`, `/docs/launchpad/migration`, `/docs/integration/bridge`, `/docs/integration/gas-station`, `/docs/integration/indexing`, `/docs/reference/addresses` | VERIFIED_IN_UI |
| Token profile route (`/tokens/{address}`) | Existence inferred from the "isn't a token on Arc" address-validation error | INFERRED |
| Portfolio page contents | Total-value card ("Not connected", "$0.00") + Positions table (Asset/Amount/Value) with connect prompt | VERIFIED_IN_UI (see §8.3b) |
| Gas page contents | Two-panel pay-eUSD / receive-gas-USDC form with pricing footnote | VERIFIED_IN_UI (see §8.3c) |

### 8.2 Bridge screen

Updated 2026-07-28 from user-provided screenshots of the live app.

| Item | Observation | Status |
|---|---|---|
| From panel | "From" label + chain chip (Base, blue square icon) top-right; large "0.00" amount input; USD value beneath ("$0.00"); "Balance: 0.00 USDC" with a "Max" chip | VERIFIED_IN_UI |
| Direction switch | Dark circular ⇅ button overlapping the seam between the From and To panels | VERIFIED_IN_UI |
| To panel | "To" label + Arc chain chip; large computed output; asset chip (eUSD); hint text "You receive on Arc" | VERIFIED_IN_UI |
| Rate line | Shows the net rate including fee: "Rate — 1 USDC = 0.9 eUSD" (consistent with the on-chain 10% deposit fee) | VERIFIED_IN_UI |
| Fee line | "Fee — 10%" shown as a percentage before any wallet interaction | VERIFIED_IN_UI (corroborates VERIFIED_ONCHAIN `feeBps()=1000`) |
| Estimated time | "Estimated time — 1 min" | VERIFIED_IN_UI |
| Primary CTA | Full-width black "Connect wallet" button inside the form (plus header button) | VERIFIED_IN_UI |
| Status history | "Bridge status" section below the form with a "Last 7 days" scope label | VERIFIED_IN_UI |
| Social links | Discord and X floating buttons bottom-right | VERIFIED_IN_UI |
| Completion semantics | Frontend must poll destination result; source receipt ≠ completion | VERIFIED_FROM_DOCS (API design) / INFERRED (UI behavior) |
| Connected-state modals and per-state visuals | Require a connected wallet to observe | UNKNOWN — Arch defines its own full state machine (§8.5) |

### 8.3 Create-token screen

Updated 2026-07-28 from screenshots.

| Item | Observation | Status |
|---|---|---|
| Wizard structure | Three-step progress header: "1. Token" → "2. Setup" → "3. Review", with an underline indicating the active step | VERIFIED_IN_UI |
| Step 1 card | Titled "Token identity" with helper copy ("Add the details people will see across the launchpad.") | VERIFIED_IN_UI |
| Image field | "Token image" upload tile with guidance: "Square PNG, JPG, GIF, or WebP recommended." | VERIFIED_IN_UI |
| Name/symbol | "Token name" (required, placeholder "e.g. Paper Plane") and "Symbol" (required, placeholder "PLANE") side by side | VERIFIED_IN_UI |
| Description | Optional multi-line textarea ("What is this token about?") | VERIFIED_IN_UI |
| Social links | Optional, collapsed accordion section | VERIFIED_IN_UI |
| Step CTA | Full-width "Continue" button | VERIFIED_IN_UI |
| Step 2 ("Setup") contents | Not captured; per docs the pair choice (USDC or eUSD) lives somewhere in the flow — presumed step 2 with any creator purchase/slippage | INFERRED |
| Step 3 ("Review") contents | Not captured | UNKNOWN — Arch implements its spec'd review (fees, supply, pair, creator buy, permanent-liquidity notice) |
| Field limits and validation rules | Not observable | UNKNOWN — Arch defines its own limits |

### 8.3a Token discovery (Tokens tab)

Captured 2026-07-28 from screenshots.

| Item | Observation | Status |
|---|---|---|
| Heading + sorts | "Tokens" heading with pill toggle: "Newest" \| "Market cap" (active pill highlighted) | VERIFIED_IN_UI |
| Search | Single input, placeholder "Search name, symbol or address" | VERIFIED_IN_UI |
| Migration chip | An "ⓘ eUSD migration" info chip above the list | VERIFIED_IN_UI |
| List columns | Token · Price · Market cap | VERIFIED_IN_UI |
| Row contents | Token image with a small quote-asset badge overlay (eUSD logo), bold ticker + copy-address icon, then "Name · age" (e.g. "Just a Circle · 4d ago") | VERIFIED_IN_UI |
| Formats | Sub-cent prices at 3 significant figures ("$0.0000584"); market caps abbreviated ("$58K") | VERIFIED_IN_UI |
| Ticker uniqueness | Not enforced — two distinct tokens both display ticker "USDC" | VERIFIED_IN_UI (note: tickers can impersonate assets; Arch UI must make the real asset identity unmistakable) |
| Volume/liquidity/graduation columns | Not present in the captured list view | VERIFIED_IN_UI (absent) — Arch keeps richer columns per its spec and records the divergence |

### 8.3b Portfolio tab

| Item | Observation | Status |
|---|---|---|
| Summary card | Avatar placeholder + "Not connected" + "$0.00" total | VERIFIED_IN_UI |
| Positions table | Headers: Asset · Amount · Value; empty state "Connect your wallet to see your positions." | VERIFIED_IN_UI |

### 8.3c Gas tab

| Item | Observation | Status |
|---|---|---|
| Heading | "Gas" with fuel-pump icon; copy: "Arc charges gas in USDC. Buy some with eUSD, then swap and launch without interruption." | VERIFIED_IN_UI |
| You pay | Amount panel with eUSD asset chip and "Balance: –" | VERIFIED_IN_UI |
| You receive | "You receive (gas)" panel with USDC chip and "Balance: –" | VERIFIED_IN_UI |
| CTA | "Connect wallet" | VERIFIED_IN_UI |
| Pricing footnote | "Gas is sold at the rate the gas station sets, which covers the cost of fronting native USDC. Bridging in USDC directly is cheaper if you have the option." | VERIFIED_IN_UI — Arch mirrors this honesty (visible 5% margin + cheaper-alternative note) |

### 8.4 Token page and trading

Updated 2026-07-29 from a user-provided screenshot of the live token page.

| Item | Observation | Status |
|---|---|---|
| Header row | Back chevron · token image (with quote badge) · bold ticker · name · shortened address + copy icon · X link — and on the right a large price ("$0.000855") with signed 24h change beneath, red/green | VERIFIED_IN_UI |
| Trade card | "Buy \| Sell" pill tabs; "You pay" panel (balance top-right, eUSD chip, big amount input) with 25% / 50% / 75% / Max chips; "You receive" panel with token chip; "Estimated gas 0.0057" and "Gas balance 0.0000" rows; full-width Connect wallet CTA | VERIFIED_IN_UI |
| Chart card | Smooth price line/area chart with right-side price axis and time x-axis; interval toggle pills ("5m \| 15m"); stats row beneath: Market cap · Liquidity · 24h volume · Created ("4d ago") | VERIFIED_IN_UI |
| Trades tab | "Trades \| Holders" pill tabs with total count ("1,223 trades"); columns Type (Buy green / Sell red) · Wallet (identicon + short address) · Amount (token) · Value ($) · Time ("38m ago"); numbered pagination | VERIFIED_IN_UI |
| Holders tab | Total count ("232 holders"); columns # · Wallet (identicon + short address, "LP" badge on the pool, linked to explorer) · Amount · Supply (bar + percent); numbered pagination | VERIFIED_IN_UI |
| LP share at scale | At $855K market cap the pool was the top holder at 6.01% of supply. This is emergent, not configured: launches start with 100% of supply in the single-sided position, and buys drain tokens as price rises along the range — at ~285× the starting mcap, ~6% remains. Arch's identical launch parameters reproduce the same curve exactly. | VERIFIED_IN_UI (observation) — parity automatic |
| Trading mechanics | Direct Uniswap v3 at 1% tier via standard router | VERIFIED_FROM_DOCS |
| Graduation display | Permanent label applied by the app at $9,000 pool balance | VERIFIED_FROM_DOCS |
| Creator rewards display | Rewards accrue for pool life; fixed recipients | VERIFIED_FROM_DOCS (mechanics) / UNKNOWN (display) |
| Explorer links | Arc explorer `arc.exploreme.pro` used for addresses | VERIFIED_FROM_DOCS |

### 8.5 Wallet and transaction states

Envelope's per-state UI is client-rendered and was not observable. Arch implements the full state machine from its own spec (disconnected; connected to Base/Arc; wrong network; unsupported network; requesting switch; switch rejected; no USDC; no aUSD; no Arc gas; approval required/pending; signature pending; transaction pending/confirmed; bridge destination pending; complete; retryable error) and marks the whole set **INFERRED** as an Envelope-parity claim while being fully specified for Arch.

Mobile behavior: **UNKNOWN** (not observable) — Arch targets fully responsive layouts as its own requirement.

## 9. Intentional Arch divergences (mandated)

| Area | Envelope (verified) | Arch (mandated) |
|---|---|---|
| Bridged dollar | eUSD, "Envelope USD" | aUSD, "Arch USD" |
| Deposit fee | 10% (1000 bps) | 15% (1500 bps) |
| Quote-side LP fee split | 35% creator / 65% platform | 30% creator / 70% protocol |
| Launch fee | 50 quote units | 52.5 quote units (105%) |
| Gas-station actions | 0=swap, 1=launch | 0=swap, 1=launch, 2=redemption, 3=approval |
| Gas-station margin | undisclosed | visible 5% margin |
| `Launched` event | 5 fields | + `string metadataUri` |
| `Deposited` event | net + fee | + gross amount + nonce |
| Factory implementation | appears proxied | no upgradeable proxies |
| Price math | JS `Number` shown in docs | exact bigint only |
| Creator initial purchase | not documented | optional atomic creator buy |

Unchanged parity anchors: 1B fixed supply / 18 decimals; single-sided v3 position; 1% fee tier; permanent liquidity lock; ~$3,000 starting mcap; $9,000 graduation (UI-only, permanent); token-side fees 100% burned; free 1:1 redemption; asynchronous mint/release with confirmation depth; per-tx/per-block release caps; pause-gated reserve migration; 1:1 no-deadline aUSD→USDC exchange that "cannot open underwater"; automatic pool migration preserving price and amounts; permissionless fee distribution; live on-chain fee reads in the UI.

## 10. Open questions carried into implementation

1. Arc mainnet's official chain ID / RPC / explorer must be confirmed against official Circle/Arc publications before `ENABLE_ARC_MAINNET=true`. Envelope's observed chain 5042 is evidence, not authority.
2. Exact confirmation depths (Base and Arc) are Arch policy choices; defaults are conservative and configurable.
3. Envelope bridge/gas API response schemas are unpublished; Arch defines and documents its own (OpenAPI).
4. Uniswap v3 deployment on Arc testnet (for Arch's testnet phase) must be located or deployed by Arch itself; the chain-5042 addresses above cannot be assumed to exist on testnet.
5. Envelope's launch-fee payment asset (eUSD vs USDC vs either) for `launchFee()` was not disambiguated; Arch charges the fee in the selected pair token and documents this.
