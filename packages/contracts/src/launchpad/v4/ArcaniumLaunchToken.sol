// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IRewardsVault {
    function payOut(address token, address holder) external returns (uint256);
}

/**
 * @title Arcanium launch token (v4)
 * @notice Fixed supply, no owner, no minting, and no transfer tax.
 *
 * Written fresh rather than reusing ArchLaunchTokenV2, because most of what
 * that contract does is now somebody else's job. Its swap tax lived in
 * `_update` and had to recognise the pool to know which transfers were trades;
 * on v4 the hook takes the fee inside the swap, so the token does not need to
 * know what a pool is, and an ordinary transfer is just a transfer. Carrying
 * the old machinery forward would mean shipping a tax that can never fire and
 * a pool binding nothing reads.
 *
 * What remains is the Divium accounting, which still belongs here: rewards are
 * proportional to balances, and balances are the one thing only the token
 * sees. It is a cumulative index, so accrual is O(1) per transfer no matter how
 * many holders there are, and nothing has to be iterated.
 *
 * The vault — the hook — holds the USDC and is the only address allowed to
 * book or settle rewards. Splitting those powers across two addresses was what
 * forced the old design into a corner: the token accepted notifications from
 * one address and consumption from the same one, so the contract that received
 * the money had to be the contract that paid it out.
 */
contract ArcaniumLaunchToken is ERC20 {
    uint256 public constant FIXED_SUPPLY = 1_000_000_000 ether;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice The launchpad that deployed this token.
    address public immutable factory;
    /// @notice Holds the reward asset and is the only address that may move it.
    address public immutable rewardsVault;
    /// @notice True only for a Divium launch.
    bool public immutable rewardsEnabled;

    // ---- Divium accrual (cumulative index; O(1) per transfer) ----

    /// @dev 1e36 keeps sub-cent 6-decimal rewards from truncating to zero
    ///      against an 18-decimal supply. A 1e18 index loses them entirely.
    uint256 public constant ACC_PRECISION = 1e36;
    uint256 public rewardPerTokenStored;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewardsAccrued;
    /// @notice Supply that actually earns — excludes the pool, the sink and
    ///         the vault, none of which are holders in any meaningful sense.
    uint256 public rewardEligibleSupply;
    mapping(address => bool) public excludedFromRewards;

    /// @dev Guards the auto-payout against re-entering through a transfer.
    bool private _paying;

    event RewardsExcluded(address indexed account);

    error OnlyFactory();
    error OnlyVault();

    constructor(
        string memory name_,
        string memory symbol_,
        address rewardsVault_,
        bool rewardsEnabled_
    ) ERC20(name_, symbol_) {
        factory = msg.sender;
        rewardsVault = rewardsVault_;
        rewardsEnabled = rewardsEnabled_;

        // The factory holds the supply only long enough to build the pool, and
        // neither it, the sink, nor the vault is a holder to pay.
        excludedFromRewards[msg.sender] = true;
        excludedFromRewards[BURN_ADDRESS] = true;
        excludedFromRewards[rewardsVault_] = true;

        _mint(msg.sender, FIXED_SUPPLY);
    }

    /**
     * @notice Mark an address as not earning rewards. Factory-only.
     * @dev Used for the PoolManager, which holds the launch liquidity. Paying
     *      rewards to the venue would route most of every distribution to the
     *      pool and back out as price, rather than to the people holding.
     */
    function excludeFromRewards(address account) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (excludedFromRewards[account]) return;
        _bookRewards(account);
        if (balanceOf(account) > 0) rewardEligibleSupply -= balanceOf(account);
        excludedFromRewards[account] = true;
        emit RewardsExcluded(account);
    }

    // ------------------------------------------------------------- rewards

    /// @notice Vault-only: book new rewards against the eligible supply.
    function notifyRewardAmount(uint256 amount) external {
        if (msg.sender != rewardsVault || !rewardsEnabled) return;
        uint256 eligible = rewardEligibleSupply;
        if (eligible == 0 || amount == 0) return;
        rewardPerTokenStored += (amount * ACC_PRECISION) / eligible;
    }

    /// @notice What `account` could be paid right now.
    function earned(address account) public view returns (uint256) {
        if (!rewardsEnabled || excludedFromRewards[account]) return rewardsAccrued[account];
        uint256 delta = rewardPerTokenStored - userRewardPerTokenPaid[account];
        return rewardsAccrued[account] + (balanceOf(account) * delta) / ACC_PRECISION;
    }

    /// @notice Vault-only: zero an account's booked rewards, having paid them.
    function consumeRewards(address account) external returns (uint256 amount) {
        if (msg.sender != rewardsVault) revert OnlyVault();
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

    function _update(address from, address to, uint256 value) internal override {
        // Book both sides at pre-move balances so accrual is exact.
        _bookRewards(from);
        _bookRewards(to);

        super._update(from, to, value);

        _adjustEligible(from, to, value);

        // Pay the sender what they have earned, in the transaction they were
        // already sending. This is what makes rewards feel automatic for
        // anyone who trades rather than something they must remember to go and
        // collect.
        //
        // Best-effort on purpose. The reward asset is Arc's USDC, which moves
        // native balance, so a recipient that cannot accept it would otherwise
        // make every transfer from that address fail. A payout that cannot
        // happen leaves the rewards booked and claimable; it never blocks the
        // transfer that triggered it.
        if (
            rewardsEnabled &&
            !_paying &&
            from != address(0) &&
            !excludedFromRewards[from] &&
            rewardsAccrued[from] > 0
        ) {
            _paying = true;
            try IRewardsVault(rewardsVault).payOut(address(this), from) returns (uint256) {
                // Paid.
            } catch {
                // Still owed, still claimable.
            }
            _paying = false;
        }
    }

    /// @dev Keep the earning supply in step with who is and is not excluded.
    function _adjustEligible(address from, address to, uint256 value) private {
        if (!rewardsEnabled || value == 0) return;
        bool fromCounts = from != address(0) && !excludedFromRewards[from];
        bool toCounts = to != address(0) && !excludedFromRewards[to];
        if (fromCounts && !toCounts) rewardEligibleSupply -= value;
        else if (!fromCounts && toCounts) rewardEligibleSupply += value;
    }
}
