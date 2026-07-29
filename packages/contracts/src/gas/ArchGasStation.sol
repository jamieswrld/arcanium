// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Arch gas station
/// @notice Sells small amounts of native Arc USDC (gas) for aUSD so a wallet
///         holding only bridged aUSD can transact. The user signs a gas-free
///         EIP-2612 permit for the exact quoted aUSD amount; an Arch relayer
///         submits the drip and pays the gas.
/// @dev    Native Arc gas is USDC with an 18-decimal native view; aUSD uses a
///         6-decimal ERC-20 interface. Conversion: 1 aUSD unit = 1e12 native
///         wei. The station never sells below par: the aUSD taken always
///         covers the native amount sent plus the configured margin.
///
/// Action IDs: 0 = swap, 1 = token launch, 2 = redemption, 3 = approval.
contract ArchGasStation is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Margin can never exceed 20% — compiled-in ceiling.
    uint256 public constant MAX_MARGIN_BPS = 2_000;
    uint256 public constant NATIVE_PER_AUSD_UNIT = 1e12;
    uint8 public constant MAX_ACTION_ID = 3;

    IERC20 public immutable ausd;

    mapping(address => bool) public isRelayer;
    /// @notice Visible service margin in bps over the par gas cost (500 = 5%).
    uint256 public marginBps;
    /// @notice Estimated gas units per action, the basis for quotes.
    mapping(uint8 => uint256) public gasUnitsForAction;
    /// @notice Hard cap on native out per drip, per action.
    mapping(uint8 => uint256) public maxNativeOutForAction;
    /// @notice Per-user, per-action cooldown (rate limiting).
    uint256 public dripCooldownSeconds;
    mapping(address => mapping(uint8 => uint256)) public lastDripAt;

    bool public paused;

    event Dripped(
        address indexed user,
        uint8 indexed actionId,
        uint256 nativeOut,
        uint256 ausdIn
    );
    event RelayerUpdated(address indexed relayer, bool enabled);
    event MarginUpdated(uint256 oldMarginBps, uint256 newMarginBps);
    event ActionConfigured(uint8 indexed actionId, uint256 gasUnits, uint256 maxNativeOut);
    event CooldownUpdated(uint256 seconds_);
    event PausedSet(bool paused);
    event InventoryWithdrawn(address indexed to, uint256 nativeAmount);
    event CollectedAusdWithdrawn(address indexed to, uint256 ausdAmount);
    event InventoryFunded(address indexed from, uint256 nativeAmount);

    error NotRelayer();
    error StationPaused();
    error InvalidAction();
    error ZeroAddress();
    error MarginAboveCap();
    error ExceedsActionCap();
    error UnderpricedDrip();
    error CooldownActive();
    error InsufficientInventory();
    error NativeTransferFailed();

    modifier onlyRelayer() {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        _;
    }

    constructor(
        address ausd_,
        address owner_,
        uint256 marginBps_,
        uint256 dripCooldownSeconds_
    ) Ownable(owner_) {
        if (ausd_ == address(0)) revert ZeroAddress();
        if (marginBps_ > MAX_MARGIN_BPS) revert MarginAboveCap();
        ausd = IERC20(ausd_);
        marginBps = marginBps_;
        dripCooldownSeconds = dripCooldownSeconds_;
    }

    /// @notice Fund the station's native USDC inventory.
    receive() external payable {
        emit InventoryFunded(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ quote

    /// @notice Quote a drip for an action at a given gas price. Returns the
    ///         native USDC the user receives (18 decimals) and the aUSD they
    ///         pay (6 decimals), including the visible margin, rounded up.
    function quote(uint256 actionId, uint256 gasPrice)
        public
        view
        returns (uint256 nativeOut, uint256 ausdIn)
    {
        if (actionId > MAX_ACTION_ID) revert InvalidAction();
        uint8 id = uint8(actionId);
        nativeOut = gasUnitsForAction[id] * gasPrice;
        uint256 cap = maxNativeOutForAction[id];
        if (nativeOut > cap) nativeOut = cap;
        ausdIn = _minAusdIn(nativeOut);
    }

    /// @dev Par conversion (native 18d → aUSD 6d) plus margin, rounded up so
    ///      the station is never underpaid by a wei of rounding.
    function _minAusdIn(uint256 nativeOut) internal view returns (uint256) {
        uint256 numerator = nativeOut * (BPS_DENOMINATOR + marginBps);
        uint256 denominator = NATIVE_PER_AUSD_UNIT * BPS_DENOMINATOR;
        return (numerator + denominator - 1) / denominator;
    }

    // ------------------------------------------------------------------- drip

    /// @notice Relayer-submitted drip. The user's EIP-2612 permit authorizes
    ///         exactly `ausdIn`; the contract enforces caps, cooldown, pause,
    ///         and never-below-par pricing regardless of relayer behavior.
    function drip(
        address user,
        uint8 actionId,
        uint256 nativeOut,
        uint256 ausdIn,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyRelayer nonReentrant {
        if (paused) revert StationPaused();
        if (actionId > MAX_ACTION_ID) revert InvalidAction();
        if (user == address(0)) revert ZeroAddress();
        if (nativeOut > maxNativeOutForAction[actionId]) revert ExceedsActionCap();
        if (ausdIn < _minAusdIn(nativeOut)) revert UnderpricedDrip();
        uint256 last = lastDripAt[user][actionId];
        if (last != 0 && block.timestamp < last + dripCooldownSeconds) {
            revert CooldownActive();
        }
        if (address(this).balance < nativeOut) revert InsufficientInventory();

        lastDripAt[user][actionId] = block.timestamp;

        // Permit failure tolerance: if the allowance was already granted (e.g.
        // a retried relayer call after a mined permit), continue.
        try IERC20Permit(address(ausd)).permit(user, address(this), ausdIn, deadline, v, r, s) {
        } catch {
            // transferFrom below still requires sufficient allowance.
        }
        ausd.safeTransferFrom(user, address(this), ausdIn);

        (bool ok, ) = payable(user).call{value: nativeOut}("");
        if (!ok) revert NativeTransferFailed();

        emit Dripped(user, actionId, nativeOut, ausdIn);
    }

    // ------------------------------------------------------------------- admin

    function setRelayer(address relayer, bool enabled) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        isRelayer[relayer] = enabled;
        emit RelayerUpdated(relayer, enabled);
    }

    function setMargin(uint256 newMarginBps) external onlyOwner {
        if (newMarginBps > MAX_MARGIN_BPS) revert MarginAboveCap();
        emit MarginUpdated(marginBps, newMarginBps);
        marginBps = newMarginBps;
    }

    function configureAction(uint8 actionId, uint256 gasUnits, uint256 maxNativeOut)
        external
        onlyOwner
    {
        if (actionId > MAX_ACTION_ID) revert InvalidAction();
        gasUnitsForAction[actionId] = gasUnits;
        maxNativeOutForAction[actionId] = maxNativeOut;
        emit ActionConfigured(actionId, gasUnits, maxNativeOut);
    }

    function setCooldown(uint256 seconds_) external onlyOwner {
        dripCooldownSeconds = seconds_;
        emit CooldownUpdated(seconds_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Withdraw native inventory (e.g. rebalancing to the treasury).
    function withdrawInventory(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit InventoryWithdrawn(to, amount);
    }

    /// @notice Withdraw collected aUSD to the treasury.
    function withdrawCollectedAusd(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        ausd.safeTransfer(to, amount);
        emit CollectedAusdWithdrawn(to, amount);
    }
}
