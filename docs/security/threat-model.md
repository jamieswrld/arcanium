# Arch Threat Model (v1, Milestone 1)

Scope: bridge (Base vault ⇄ Arc aUSD), gas station, launchpad, fee distribution, migration, off-chain workers, APIs, frontend, and operations. Format: asset → threat → controls. This document gates milestone exit reviews; every control maps to a test or runbook before mainnet.

## Assets

1. **A1 — Base USDC reserve** (backs all aUSD; the crown jewel).
2. **A2 — aUSD supply integrity** (must never exceed net reserve).
3. **A3 — Locked launch liquidity** (position NFTs in `ArchLiquidityVault`).
4. **A4 — Fee streams** (creator 30% / protocol 70% quote-side; token-side burns).
5. **A5 — Relayer & keeper hot wallets** (operational float only).
6. **A6 — User funds in flight** (deposits awaiting mint, burns awaiting release).
7. **A7 — Data integrity** (indexer/API correctness; prices, candles, statuses).
8. **A8 — User trust** (accurate fees, no hidden costs, honest statuses).

## Actors

External attacker · malicious token creator · malicious trader (MEV) · compromised keeper/relayer key · malicious or compromised admin · buggy RPC provider · chain reorg · malicious metadata author.

## Threats and controls

### Bridge (A1, A2, A6)

| Threat | Controls |
|---|---|
| Double-mint from one deposit (worker crash/retry, duplicate event delivery) | Deterministic action ID `keccak256(abi.encode(txHash, logIndex))`; DB unique constraint on action ID; Redis idempotency lock; on-chain processed-ID set for releases; invariant test "one deposit → at most one mint" |
| Double-release from one burn | Same identifier scheme enforced **on-chain** in `ArchVaultBase.release` (processed mapping) — the contract, not the worker, is the last line |
| Reorg drops/reorders a deposit or burn | Confirmation-depth policy per chain (config); worker persists log then re-verifies presence at depth before acting; `reorg_detected` state; removed-log detection on subscription |
| Mint without deposit (compromised Arc minter key) | Minter role on `ArchUSD` held by bridge contract path only; per-tx and per-window mint caps; solvency monitor alerts on `supply > reserve`; pause |
| Reserve drained (compromised Base keeper) | Keeper can only call `release` with caps per tx and per block/window; cannot sweep USDC (token-rescue excludes reserve asset); treasury/multisig separation; two-step ownership |
| Fee manipulation | Fee bounded by compiled-in hard cap; changes only via timelocked multisig; events on every change; frontend reads live |
| Worker outage strands funds | Durable queue with retries + dead-letter; reconciliation tool replays from chain (chain is source of truth); admin cannot mark complete without verifiable tx evidence |
| Wrong-recipient deposits | `arcRecipient` explicit parameter, shown in review; no inference from `msg.sender` on the destination side |

### Gas station (A5)

| Threat | Controls |
|---|---|
| Quote replay / permit replay | EIP-2612 nonce; quote expiry; idempotency key; duplicate in-flight detection (409) |
| Drained drip inventory | Per-action max drip; per-user rate limit; relayer-only `drip` on-chain; emergency pause; low-balance alerting |
| Stale/undervalued quotes during gas spikes | Quote embeds gas price + expiry; contract rejects stale gas price beyond tolerance |
| Relayer key theft | Relayer holds days-of-float only, refilled from treasury by humans; key in KMS/HSM or encrypted store, never in frontend env |

### Launchpad (A3, A4)

| Threat | Controls |
|---|---|
| Liquidity rug | Position NFT owned by `ArchLiquidityVault`: no `decreaseLiquidity`, no NFT transfer, no admin path; only `collect` (fees) and the narrow migration authorization; invariant tests |
| Malicious launch token drains vault/factory | Only factory-minted `ArchLaunchToken` instances registered; factory holds zero residual supply post-launch (invariant); fee distributor handles arbitrary-revert tokens defensively (per-pool isolation so one bad pool can't block batch) |
| Creator-buy front-running | Creator buy executes atomically inside the launch tx with `minTokensOut` + `deadline`; launch initializes price before any external swap can occur |
| Fee-split manipulation | Creator recipient immutable per launch; 30/70 split constant-checked against hard caps; token-side fees can only go to burn |
| Token ordering bugs (token0/token1) | Both orderings covered by unit + fuzz tests on price/tick/liquidity math |
| Malicious metadata (XSS, phishing links, SVG bombs) | Server-side sanitization; URL allowlist schemes; image proxy + strict CSP; size/type limits; no raw HTML rendering |

### Migration (A1, A2, A3)

Undercollateralized exchange opening → contract refuses unless on-hand USDC ≥ outstanding aUSD (invariant + fork tests). Pool migration value distortion → per-pool before/after assertions on price and amounts; no neutrality claim until tests prove it. Unauthorized migration → distinct migration role behind timelock + multisig; ordinary admins cannot invoke.

### Data & API (A7, A8)

Indexer poisoning via reorg → cursor tracks block hash, rewinds on mismatch, candles rebuilt from persisted swaps. Price corruption via float math → bigint-only pipeline, lint rule bans `Number()` on chain values. API abuse → rate limits, pagination caps, input validation (address checksums). Status lies → UI completion requires destination confirmation, never source receipt.

### Operations

Single-wallet compromise → distinct addresses/roles: protocol multisig, bridge treasury, trading-fee treasury, launch-fee treasury, relayer, Base keeper, Arc keeper, deployer, security council. Admin abuse → all admin actions audited (append-only log), evidence-required reconciliation, timelocks on config. RPC failure/lies → multi-provider failover; cross-check receipts on a second provider for release-critical reads.

## Mainnet no-go gate

Independent audit; bridge solvency review; keeper threat-model review; migration review; multisig configuration review; public bug bounty; incident-response runbook; rehearsed pause-and-recovery exercise. Until all pass and the address book is verified against official sources: `ENABLE_ARC_MAINNET=false`, `ENABLE_REAL_BRIDGE=false`, `ENABLE_REAL_TRADING=false`.
