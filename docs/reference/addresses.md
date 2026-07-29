# Arch contract addresses

All deployments are recorded here with chain, deployer, and date. Mainnet
sections stay empty until the launch gate passes (ADR 0006).

## Arc Testnet (chain 5042002)

| Contract | Address | Deployed | Notes |
|---|---|---|---|
| ArchUSD (aUSD) | `0x4297254e5ae2df2b0d3920a08df582d61b3e7766` | 2026-07-29 | 6 decimals; BRIDGE_ROLE held solely by ArchBridgeArc |
| ArchBridgeArc | `0x81d414d2cd66bf4422036846f569a6189996fd59` | 2026-07-29 | minRedeem 1 aUSD; mint caps 100k/tx, 500k/hr |
| USDC (native gas, ERC-20 view) | `0x3600000000000000000000000000000000000000` | — | Circle precompile |

Explorer: https://testnet.arcscan.app

## Base Sepolia (chain 84532)

| Contract | Address | Deployed | Notes |
|---|---|---|---|
| ArchVaultBase | `0x4297254E5ae2df2b0d3920A08Df582D61b3e7766` | 2026-07-29 | fee 1500 bps; testnet limits 1 / 100,000 USDC |
| USDC (Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | — | Circle's published testnet USDC |

Explorer: https://sepolia.basescan.org

## Operational addresses (testnet phase)

| Role | Address |
|---|---|
| Deployer / owner / treasury / keeper (testnet only — roles separate before mainnet) | `0x582525844FC8D68C5B7515d2199CDd4f72C6816a` |

## Arc Mainnet / Base Mainnet

Not deployed. Gated by `ENABLE_ARC_MAINNET` / `ENABLE_REAL_BRIDGE` and the
security launch gate (audit, solvency review, multisig + timelock, bug bounty).
