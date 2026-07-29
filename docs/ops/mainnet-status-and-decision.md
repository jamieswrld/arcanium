# Mainnet: verified status and the real decision (2026-07-29)

## The hard fact

**Arc's official mainnet does not exist yet.** Circle's own documentation — the
only authority that matters — still states verbatim: *"Arc is currently
available on Testnet only."* The mainnet **beta** is a *summer-2026 window*
(per Circle's whitepaper coverage), not a confirmed-live network with published
parameters. There is no official Arc mainnet chain ID, RPC, explorer, or USDC
address to deploy against.

Deploying to a *guessed* "Arc mainnet" is exactly the fabrication the build
rules forbid, and it would put real user USDC behind parameters no one can
verify. So "deploy to Arc mainnet tonight" is, strictly, not possible: there is
nothing official to deploy to.

## What IS live: chain 5042 (Envelope's real network)

Envelope runs its real-money operation on **chain 5042** (`0x13b2`), paired with
**Base mainnet**. Verified on-chain 2026-07-29:

| Item | Value | Verified |
|---|---|---|
| Chain 5042 live | block ~12.76M, responding | ✅ RPC `https://5042.rpc.thirdweb.com` |
| USDC (native, precompile) | `0x3600…0000`, 6 decimals | ✅ code + decimals read |
| Uniswap v3 PositionManager | `0x3965…1377` | ✅ code present |
| Uniswap v3 SwapRouter | `0x4C91…4720` | ✅ code present |
| Base mainnet USDC (canonical) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | ✅ code present |
| Official Circle/Arc branding of 5042 as "mainnet" | none found | ❌ Circle docs say testnet-only; no official explorer (Envelope uses a third-party one) |

**Interpretation:** chain 5042 is a functioning EVM network with USDC + Uniswap
where Envelope custodies real value. It is very likely Arc's actual production
network (early/beta), but Circle does not officially document it as mainnet, and
its permanence/security guarantees cannot be independently verified. That is a
real, un-mitigable-by-code risk to disclose to anyone depositing.

## The decision (yours, with eyes open)

**Path A — Match Envelope exactly: Base mainnet ⟷ chain 5042, real money now.**
Operationally identical to Envelope. Requires the key ceremony below, capped-beta
limits, and knowingly accepting two risks:
1. **Unaudited contracts holding user funds** — the standard way bridges get
   drained. (Envelope is presumably also unaudited; that is not a safety
   argument, only a parity fact.)
2. **Chain 5042 provenance** — not officially blessed by Circle as mainnet.

**Path B — Wait for official Arc mainnet** (Circle's summer-2026 beta, when real
parameters publish) and/or get a security review first. Slower, materially safer.

There is no Path where I deploy a real-funds bridge to a network whose official
parameters don't exist — that number would be invented, and I won't invent it.

## Two things only YOU can do (both paths, before any real deposit)

### 1. Key ceremony (hard blocker)

Every key used in the testnet build was generated inside an AI session and
appears in logs — **burned for mainnet by definition.** Mainnet needs freshly
generated keys the model never sees in plaintext at rest:

- **Deployer** — deploys contracts, then hands ownership to the multisig.
- **Base keeper** — signs `release` on Base. Hot, small ETH float only.
- **Arc keeper** — signs `mintDeposit` on chain 5042. Hot, small gas float only.
- **Relayer** — signs gas-station drips. Hot, small float only.
- **Protocol multisig** — owns every contract (use a Safe). Not an EOA.
- **Your 5 fee wallets** — already yours (the MetaMask set); the 40% wallet
  should move to a hardware signer since revenue concentrates there.

Generate these yourself (MetaMask / hardware / a Safe). The three hot keeper/
relayer keys must live only in the server's secret store (Railway encrypted
vars), hold days-of-gas only, and never touch a treasury. I will wire whatever
addresses/keys you provision; I will not generate production keys for you.

### 2. Risk acceptance

Going live without an audit is you choosing to accept bridge-drain risk. The
contracts have caps, pauses, and 81 passing tests, but tests are not an audit.
The mitigation that actually bounds exposure tonight is a **tight capped beta**
(e.g. max deposit $50–100, low per-window release caps) so a worst case is
small while real usage proves the system.

## What I will do the moment you decide Path A + provide addresses

1. Verify the full chain-5042 + Base-mainnet address book one more time and pin
   it in `mainnet-addresses.md` with sources.
2. Set `ENABLE_ARC_MAINNET=true` only after every required address is present.
3. Deploy Base vault + fee splitter to Base mainnet; aUSD + bridge + gas station
   + launchpad + splitter to chain 5042 — with capped-beta parameters.
4. Transfer all ownership to your multisig (two-step accept).
5. Run one small canary: real deposit → mint → redeem → release, end to end.
6. Point the workers/indexer (Railway) and the site (Vercel) at mainnet config.
7. Keep `ENABLE_REAL_BRIDGE` gated until the canary passes and you say go.
