# Arch mainnet address book (Path A: Base mainnet ⟷ chain 5042)

Verified on-chain 2026-07-29. Chain 5042 is the network Envelope operates on
(not officially branded Arc mainnet by Circle — see mainnet-status-and-decision.md).

## External addresses (verified, code present)

| Chain | Contract | Address |
|---|---|---|
| Base mainnet (8453) | USDC (canonical Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Chain 5042 | USDC (native precompile, 6 dec) | `0x3600000000000000000000000000000000000000` |
| Chain 5042 | Uniswap v3 PositionManager | `0x39654A85a4C05127F5fD6ED22CaEc077A0FB1377` |
| Chain 5042 | Uniswap v3 SwapRouter | `0x4C91C54e60b59B1f949AF57064eA70bd73434720` |
| Base mainnet RPC | | `https://mainnet.base.org` |
| Chain 5042 RPC | | `https://5042.rpc.thirdweb.com` |
| Chain 5042 explorer (third-party, as Envelope uses) | | `https://arc.exploreme.pro` |

## Envelope live parameters (parity reference, verified 2026-07-29)

| Param | Envelope | Arch default (mandated) |
|---|---|---|
| Bridge deposit fee | 1000 bps (10%) | 1500 bps (15%) — override to 1000 to match |
| Min deposit | 25 USDC | 25 USDC |
| Max deposit | 100,000 USDC | capped-beta start recommended (e.g. 50–100) |
| Launch fee | 50,000,000 (50 units) | 52,500,000 (52.5) |
| Creator fee share | 3500 bps (35%) | 3000 bps (30%) |

## Arch mainnet deployments (filled at deploy time)

| Chain | Contract | Address |
|---|---|---|
| Base mainnet | ArchVaultBase | _pending_ |
| Base mainnet | ArchFeeSplitter | _pending_ |
| Chain 5042 | ArchUSD (aUSD) | _pending_ |
| Chain 5042 | ArchBridgeArc | _pending_ |
| Chain 5042 | ArchGasStation | _pending_ |
| Chain 5042 | ArchLaunchpadFactory | _pending_ |
| Chain 5042 | ArchLiquidityVault | _pending_ |
| Chain 5042 | ArchFeeDistributor | _pending_ |
| Chain 5042 | GraduationRegistry | _pending_ |
| Chain 5042 | ArchFeeSplitter | _pending_ |

## Owner / operational addresses (filled from your key ceremony)

| Role | Address |
|---|---|
| Deployer | _your fresh key_ |
| Owner / multisig | _your Safe (or deployer for capped beta)_ |
| Base keeper | _hot, small float_ |
| Arc keeper (5042) | _hot, small float_ |
| Relayer | _hot, small float_ |
| Fee splitter recipients | your 5 MetaMask wallets (40/15/15/15/15) |
