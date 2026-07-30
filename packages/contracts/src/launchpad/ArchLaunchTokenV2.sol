// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Arch launch token (v2)
/// @notice Fixed-supply launch token with two optional creator-selected
///         features, both fixed forever at launch:
///
///         1. Swap tax — an extra fee taken ONLY on trades against the launch
///            pool (buys and sells). Wallet-to-wallet transfers are never
///            taxed, so ordinary sends, airdrops and CEX moves are untouched.
///            Selecting the default 1% tier sets this to zero: the token is
///            then a plain ERC-20 and only Uniswap's own 1% pool fee applies.
///
///         2. Holder rewards accrual (Divium) — the bookkeeping that lets a
///            distributor pay USDC to holders pro-rata over time. Accrual is
///            O(1) per transfer using the standard cumulative index pattern,
///            so it stays cheap no matter how many holders exist.
///
/// @dev    Tax is capped at 9% by the compiler so the total cost of a trade
///         can never exceed 10% (9% token tax + Uniswap's 1% pool fee).
contract ArchLaunchTokenV2 is ERC20 {
    uint256 public constant FIXED_SUPPLY = 1_000_000_000 ether;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Hard ceiling on the swap tax — 9% + the 1% pool fee = 10% max.
    uint256 public constant MAX_TAX_BPS = 900;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Extra tax on pool trades, in bps. Zero for the default tier.
    uint256 public immutable taxBps;
    /// @notice Where tax proceeds accumulate (the fee distributor).
    address public immutable taxRecipient;
    /// @notice True when holder-reward accrual is enabled (Divium mode).
    bool public immutable rewardsEnabled;
    /// @notice The launch factory — the only address allowed to set the pool.
    address public immutable factory;

    /// @notice The launch pool; trades against it are the taxed direction.
    address public pool;

    // ---- Divium accrual (cumulative index; O(1) per transfer) ----
    /// @notice USDC (6d) accrued per whole token, scaled by ACC_PRECISION.
    /// @dev 1e36 keeps tiny 6-decimal rewards from truncating to zero against an
    ///      18-decimal supply (a 1e18 index loses every sub-cent distribution).
    uint256 public constant ACC_PRECISION = 1e36;
    uint256 public rewardPerTokenStored;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewardsAccrued;
    /// @notice Supply eligible for rewards (excludes pool, burn, distributor).
    uint256 public rewardEligibleSupply;
    mapping(address => bool) public excludedFromRewards;

    error OnlyFactory();
    error PoolAlreadySet();
    error TaxAboveCap();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 taxBps_,
        address taxRecipient_,
        bool rewardsEnabled_
    ) ERC20(name_, symbol_) {
        if (taxBps_ > MAX_TAX_BPS) revert TaxAboveCap();
        taxBps = taxBps_;
        taxRecipient = taxRecipient_;
        rewardsEnabled = rewardsEnabled_;
        factory = msg.sender;

        // Factory holds the supply momentarily while it builds the pool; it is
        // never reward-eligible, and neither is the burn sink.
        excludedFromRewards[msg.sender] = true;
        excludedFromRewards[BURN_ADDRESS] = true;
        excludedFromRewards[taxRecipient_] = true;
        _mint(msg.sender, FIXED_SUPPLY);
    }

    /// @notice One-time pool binding by the factory, immediately after the
    ///         pool is created. Excluded from rewards (it is the market, not a
    ///         holder) and is the reference for taxed trades.
    function setPool(address pool_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (pool != address(0)) revert PoolAlreadySet();
        pool = pool_;
        excludedFromRewards[pool_] = true;
    }

    // ------------------------------------------------------------ rewards

    /// @notice Called by the distributor when it adds USDC for holders.
    /// @dev    Permissionless-safe: it only increases the index in proportion
    ///         to what the caller reports; the distributor is the only party
    ///         that actually holds and pays out the USDC.
    function notifyRewardAmount(uint256 usdcAmount) external {
        if (msg.sender != taxRecipient || !rewardsEnabled) return;
        uint256 eligible = rewardEligibleSupply;
        if (eligible == 0 || usdcAmount == 0) return;
        rewardPerTokenStored += (usdcAmount * ACC_PRECISION) / eligible;
    }

    /// @notice Rewards owed to `account` that have not yet been booked.
    function earned(address account) public view returns (uint256) {
        if (!rewardsEnabled || excludedFromRewards[account]) return rewardsAccrued[account];
        uint256 delta = rewardPerTokenStored - userRewardPerTokenPaid[account];
        return rewardsAccrued[account] + (balanceOf(account) * delta) / ACC_PRECISION;
    }

    /// @notice Distributor-only: zero an account's booked rewards after paying.
    function consumeRewards(address account) external returns (uint256 amount) {
        if (msg.sender != taxRecipient) return 0;
        _bookRewards(account);
        amount = rewardsAccrued[account];
        rewardsAccrued[account] = 0;
    }

    function _bookRewards(address account) internal {
        if (!rewardsEnabled || account == address(0)) return;
        if (excludedFromRewards[account]) {
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
            return;
        }
        uint256 delta = rewardPerTokenStored - userRewardPerTokenPaid[account];
        if (delta > 0) {
            rewardsAccrued[account] += (balanceOf(account) * delta) / ACC_PRECISION;
        }
        userRewardPerTokenPaid[account] = rewardPerTokenStored;
    }

    // ------------------------------------------------------------ transfers

    /// @dev Single hook for tax + reward accounting. Rewards are booked at
    ///      pre-move balances for both sides, then eligible supply is adjusted.
    function _update(address from, address to, uint256 value) internal override {
        // Book rewards before balances change so accrual is exact.
        _bookRewards(from);
        _bookRewards(to);

        uint256 taxed = 0;
        address poolAddr = pool;
        bool isTrade = poolAddr != address(0) && (from == poolAddr || to == poolAddr);
        // Never tax the factory's own liquidity provisioning, or tax transfers
        // involving the recipient itself (which would recurse).
        bool exempt = from == factory || to == factory || from == taxRecipient || to == taxRecipient;

        if (taxBps > 0 && isTrade && !exempt && from != address(0) && to != address(0)) {
            taxed = (value * taxBps) / BPS_DENOMINATOR;
        }

        if (taxed > 0) {
            super._update(from, taxRecipient, taxed);
            _adjustEligible(from, taxRecipient, taxed);
            unchecked { value -= taxed; }
        }

        super._update(from, to, value);
        _adjustEligible(from, to, value);
    }

    /// @dev Keep rewardEligibleSupply in step with balances of eligible holders.
    function _adjustEligible(address from, address to, uint256 value) internal {
        if (!rewardsEnabled || value == 0) return;
        if (from == address(0)) {
            if (!excludedFromRewards[to]) rewardEligibleSupply += value;
        } else if (to == address(0)) {
            if (!excludedFromRewards[from]) rewardEligibleSupply -= value;
        } else {
            bool fromEligible = !excludedFromRewards[from];
            bool toEligible = !excludedFromRewards[to];
            if (fromEligible && !toEligible) rewardEligibleSupply -= value;
            else if (!fromEligible && toEligible) rewardEligibleSupply += value;
        }
    }
}
