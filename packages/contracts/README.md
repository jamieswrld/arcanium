# @arch/contracts

Foundry project for all Arch Solidity contracts.

Planned layout (contracts land in Milestones 2, 4, 5, 8 — see `docs/architecture.md`):

```text
src/
  bridge/ArchUSD.sol            aUSD: ERC-20 + EIP-2612, role-gated mint/bridge-burn, pausable
  bridge/ArchVaultBase.sol      Base USDC reserve vault: deposit (15% fee), capped release, replay-proof
  bridge/ArchBridgeArc.sol      Arc-side redeem: burn + event
  gas/ArchGasStation.sol        permit-funded native-USDC drips, relayer-only, per-action caps
  launchpad/ArchLaunchToken.sol fixed 1B supply, 18 decimals, no owner, no taxes, no upgrade
  launchpad/ArchLaunchpadFactory.sol  atomic token+pool+position+lock(+creator buy)
  launchpad/ArchLiquidityVault.sol    permanent position lock; collect-only; narrow migration path
  launchpad/ArchFeeDistributor.sol    burn token-side, split quote-side 30/70, permissionless
  launchpad/GraduationRegistry.sol    permanent 9,000-quote-unit milestone
  migration/                    aUSD→USDC exchange + pool migration
test/                           unit, fuzz, invariant, fork suites
script/                         deployment scripts per network profile
```

Setup (run once after cloning):

```sh
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
forge test
```
