// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ArchLaunchpadFactoryV5} from "../../src/launchpad/ArchLaunchpadFactoryV5.sol";
import {ArchLiquidityVault} from "../../src/launchpad/ArchLiquidityVault.sol";
import {ArchModeDistributor} from "../../src/launchpad/ArchModeDistributor.sol";
import {
    INonfungiblePositionManager,
    ISwapRouter,
    IUniswapV3PoolMinimal
} from "../../src/launchpad/interfaces/IUniswapV3.sol";

/// @notice Forked mainnet proof that one factory launches identically on a
///         6-decimal quote chain (Robinhood / USDG) and an 18-decimal quote
///         chain (BNB / USDT). The decisive assertion is cross-chain: $100 of
///         quote must buy the same number of tokens on both, because both pools
///         open at the same $3,000 cap. A decimals bug shows up as a ~1e12 gap.
contract MultiChainLaunchTest is Test {
    struct ChainCfg {
        string label;
        string rpc;
        address positionManager;
        address swapRouter;
        address quote;
    }

    struct LaunchResult {
        address token;
        address pool;
        uint160 sqrtPriceAtOpen;
        int24 tickAtOpen;
        uint256 tokensPerHundredUsd;
        uint8 quoteDecimals;
        bool tokenIsToken0;
    }

    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant CREATOR = address(0xC12EA);

    uint256 internal constant TARGET_CAP_USD = 3_000;

    function _robinhood() internal pure returns (ChainCfg memory) {
        return ChainCfg({
            label: "ROBINHOOD",
            rpc: "https://rpc.mainnet.chain.robinhood.com",
            positionManager: 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3,
            swapRouter: 0xCaf681a66D020601342297493863E78C959E5cb2,
            quote: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 // USDG, 6dp
        });
    }

    function _bnb() internal pure returns (ChainCfg memory) {
        return ChainCfg({
            label: "BNB",
            rpc: "https://bsc-dataseed.bnbchain.org",
            positionManager: 0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613,
            swapRouter: 0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2,
            quote: 0x55d398326f99059fF775485246999027B3197955 // USDT, 18dp
        });
    }

    /// Deploy the full stack on the active fork and launch one token.
    function _launch(ChainCfg memory cfg) internal returns (LaunchResult memory r) {
        r.quoteDecimals = IERC20Metadata(cfg.quote).decimals();

        ArchLiquidityVault vault = new ArchLiquidityVault(cfg.positionManager, OWNER);
        ArchLaunchpadFactoryV5 factory = new ArchLaunchpadFactoryV5(
            cfg.positionManager, cfg.swapRouter, address(vault), OWNER, cfg.quote, 0, TREASURY
        );
        ArchModeDistributor distributor = new ArchModeDistributor(
            address(factory), address(vault), OWNER, 1_000, TREASURY, address(0), cfg.swapRouter
        );
        vm.prank(OWNER);
        factory.setModeDistributor(address(distributor));

        uint256 positionId;
        vm.startPrank(CREATOR);
        (r.token, r.pool, positionId) = factory.launch(
            ArchLaunchpadFactoryV5.LaunchParams({
                name: "Multichain Test",
                symbol: "MCT",
                metadataUri: "ipfs://test",
                pairToken: cfg.quote,
                creatorBuyAmount: 0,
                minTokensOut: 0,
                deadline: block.timestamp + 600,
                feeRecipient: CREATOR,
                taxBps: 0,
                mode: 0
            })
        );
        vm.stopPrank();

        // --- pool opened at the intended price? (read BEFORE any trade) ---
        (r.sqrtPriceAtOpen, r.tickAtOpen, , , , , ) = IUniswapV3PoolMinimal(r.pool).slot0();
        r.tokenIsToken0 = r.token < cfg.quote;
        (uint160 wantSqrt, , ) = factory.launchPrice(cfg.quote, r.tokenIsToken0);
        assertEq(r.sqrtPriceAtOpen, wantSqrt, "pool did not open at the launch price");

        // The position is minted entirely to one side of spot (single-sided), so
        // the pool's in-range liquidity is 0 until the first buy walks price into
        // the range. That is the launchpad design, so assert on the position.
        assertEq(IUniswapV3PoolMinimal(r.pool).liquidity(), 0, "liquidity should start out of range");
        (, , , , , int24 posLower, int24 posUpper, uint128 posLiq, , , , ) =
            INonfungiblePositionManager(cfg.positionManager).positions(positionId);
        assertGt(posLiq, 0, "position holds no liquidity");
        assertTrue(r.tickAtOpen < posLower || r.tickAtOpen >= posUpper, "spot inside range at open");
        assertEq(
            INonfungiblePositionManager(cfg.positionManager).ownerOf(positionId),
            address(vault),
            "position not locked in the vault"
        );
        assertEq(IERC20(r.token).balanceOf(address(factory)), 0, "factory retained supply");

        // --- now buy $100 and see what it returns ---
        uint256 hundred = 100 * (10 ** r.quoteDecimals);
        deal(cfg.quote, CREATOR, hundred);
        vm.startPrank(CREATOR);
        IERC20(cfg.quote).approve(cfg.swapRouter, hundred);
        r.tokensPerHundredUsd = ISwapRouter(cfg.swapRouter).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: cfg.quote,
                tokenOut: r.token,
                fee: 10_000,
                recipient: CREATOR,
                amountIn: hundred,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
        assertGt(r.tokensPerHundredUsd, 0, "buy returned nothing");

        console2.log(string.concat("  [", cfg.label, "] quote decimals"), r.quoteDecimals);
        console2.log("    tick at open      ", r.tickAtOpen);
        console2.log("    launch cap USD    ", _capUsd(r));
        console2.log("    tokens for $100   ", r.tokensPerHundredUsd / 1e18);
    }

    /// Fully-diluted value at the opening price, in whole dollars.
    /// Ordering is chosen so no intermediate overflows a uint256 for either the
    /// 6- or 18-decimal constant set.
    function _capUsd(LaunchResult memory r) internal pure returns (uint256) {
        uint256 s = uint256(r.sqrtPriceAtOpen);
        uint256 scale = 1e9 * (10 ** (18 - r.quoteDecimals)); // 1B supply, decimal normalisation
        if (r.tokenIsToken0) {
            // launched token sorts first -> quote per token = s^2 / 2^192
            return (s * s * scale) >> 192;
        }
        // launched token sorts second -> quote per token = 2^192 / s^2, split to
        // avoid overflowing when multiplying 2^192 by the scale in one go.
        uint256 half = ((uint256(1) << 96) * scale) / s;
        return (half * (uint256(1) << 96)) / s;
    }

    function _assertLaunchCap(LaunchResult memory r) internal pure {
        uint256 cap = _capUsd(r);
        assertGt(cap, (TARGET_CAP_USD * 97) / 100, "launch cap below target");
        assertLt(cap, (TARGET_CAP_USD * 103) / 100, "launch cap above target");
    }

    function test_Robinhood_LaunchesAtTargetCap() public {
        vm.createSelectFork(_robinhood().rpc);
        _assertLaunchCap(_launch(_robinhood()));
    }

    function test_Bnb_LaunchesAtTargetCap() public {
        vm.createSelectFork(_bnb().rpc);
        _assertLaunchCap(_launch(_bnb()));
    }

    /// The decisive one: identical dollars in, near-identical tokens out,
    /// across a 6-decimal and an 18-decimal quote asset.
    function test_SameDollarsBuySameTokensOnBothChains() public {
        vm.createSelectFork(_robinhood().rpc);
        uint256 rhTokens = _launch(_robinhood()).tokensPerHundredUsd;

        vm.createSelectFork(_bnb().rpc);
        uint256 bnbTokens = _launch(_bnb()).tokensPerHundredUsd;

        uint256 hi = rhTokens > bnbTokens ? rhTokens : bnbTokens;
        uint256 lo = rhTokens > bnbTokens ? bnbTokens : rhTokens;
        uint256 driftPct = ((hi - lo) * 100) / hi;
        console2.log("  robinhood tokens", rhTokens / 1e18);
        console2.log("  bnb tokens      ", bnbTokens / 1e18);
        console2.log("  drift %         ", driftPct);
        // Tick snapping differs slightly between the two constant sets, so allow
        // a small gap — a decimals bug would be off by orders of magnitude.
        assertLt(driftPct, 5, "chains price differently");
    }
}
