// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Arch Base vault
/// @notice Receives USDC deposits on Base, takes the visible bridge entry fee,
///         and holds the reserve that backs every aUSD on Arc. Redemptions are
///         released one-for-one against verified Arc burns, replay-proof and
///         rate-capped on-chain.
/// @dev    The owner is expected to be the timelocked protocol multisig;
///         keepers are low-privilege hot wallets that can only release within
///         the configured caps. The reserve can never be swept: token rescue
///         excludes USDC entirely, and the only outward paths are capped
///         releases and the pause-gated, publicly visible migration.
contract ArchVaultBase is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Compiled-in ceiling: not even the multisig can push the
    ///         deposit fee above 20%.
    uint256 public constant MAX_FEE_BPS = 2_000;

    IERC20 public immutable usdc;

    address public treasury;
    mapping(address => bool) public isKeeper;

    /// @notice Bridge entry fee in basis points (1500 = 15%).
    uint256 public feeBps;
    uint256 public minDeposit;
    uint256 public maxDeposit;

    bool public depositsPaused;
    bool public releasesPaused;

    /// @notice Net USDC retained as reserve backing outstanding aUSD.
    uint256 public totalReserve;

    uint256 public maxReleasePerTx;
    uint256 public maxReleasePerWindow;
    uint256 public releaseWindowSeconds;
    uint256 public currentWindowStart;
    uint256 public currentWindowReleased;

    /// @notice Redemption ids (keccak256(abi.encode(arcTxHash, logIndex)))
    ///         that have already been released. The contract, not the worker,
    ///         is the final replay barrier.
    mapping(bytes32 => bool) public processedRedemptions;

    address public migrationTarget;
    uint256 public depositNonce;

    event Deposited(
        address indexed sender,
        address indexed arcRecipient,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount,
        uint256 nonce
    );
    event Released(
        bytes32 indexed redemptionId,
        bytes32 arcTransactionHash,
        uint256 logIndex,
        address indexed baseRecipient,
        uint256 amount
    );
    event FeeBpsUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event KeeperUpdated(address indexed keeper, bool enabled);
    event DepositLimitsUpdated(uint256 minDeposit, uint256 maxDeposit);
    event ReleaseLimitsUpdated(
        uint256 maxReleasePerTx, uint256 maxReleasePerWindow, uint256 releaseWindowSeconds
    );
    event DepositsPausedSet(bool paused);
    event ReleasesPausedSet(bool paused);
    event MigrationTargetUpdated(address oldTarget, address newTarget);
    event ReserveMigrated(address indexed target, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    error NotKeeper();
    error DepositsArePaused();
    error ReleasesArePaused();
    error AmountOutOfRange();
    error ZeroAddress();
    error FeeAboveCap();
    error AlreadyProcessed(bytes32 redemptionId);
    error ReleaseExceedsTxCap();
    error ReleaseExceedsWindowCap();
    error InsufficientReserve();
    error CannotRescueReserveAsset();
    error MigrationNotConfigured();
    error MigrationRequiresPause();

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    constructor(
        address usdc_,
        address owner_,
        address treasury_,
        uint256 feeBps_,
        uint256 minDeposit_,
        uint256 maxDeposit_,
        uint256 maxReleasePerTx_,
        uint256 maxReleasePerWindow_,
        uint256 releaseWindowSeconds_
    ) Ownable(owner_) {
        if (usdc_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeAboveCap();
        usdc = IERC20(usdc_);
        treasury = treasury_;
        feeBps = feeBps_;
        minDeposit = minDeposit_;
        maxDeposit = maxDeposit_;
        maxReleasePerTx = maxReleasePerTx_;
        maxReleasePerWindow = maxReleasePerWindow_;
        releaseWindowSeconds = releaseWindowSeconds_;
        currentWindowStart = block.timestamp;
    }

    // ---------------------------------------------------------------- deposits

    /// @notice Deposit USDC on Base to receive aUSD on Arc at `arcRecipient`.
    ///         The fee is taken here, in the open, inside this transaction;
    ///         the bridge worker later mints exactly `netAmount` on Arc.
    function deposit(uint256 amount, address arcRecipient) external nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        if (arcRecipient == address(0)) revert ZeroAddress();
        if (amount < minDeposit || amount > maxDeposit) revert AmountOutOfRange();

        uint256 feeAmount = (amount * feeBps) / BPS_DENOMINATOR;
        uint256 netAmount = amount - feeAmount;

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (feeAmount > 0) {
            usdc.safeTransfer(treasury, feeAmount);
        }
        totalReserve += netAmount;

        uint256 nonce = depositNonce++;
        emit Deposited(msg.sender, arcRecipient, amount, feeAmount, netAmount, nonce);
    }

    // ---------------------------------------------------------------- releases

    /// @notice Release USDC one-for-one against a verified aUSD burn on Arc.
    ///         The redemption id is deterministic and can never be processed
    ///         twice.
    function release(
        bytes32 arcTransactionHash,
        uint256 logIndex,
        address baseRecipient,
        uint256 amount
    ) external onlyKeeper nonReentrant {
        if (releasesPaused) revert ReleasesArePaused();
        if (baseRecipient == address(0)) revert ZeroAddress();
        if (amount > maxReleasePerTx) revert ReleaseExceedsTxCap();

        bytes32 redemptionId = keccak256(abi.encode(arcTransactionHash, logIndex));
        if (processedRedemptions[redemptionId]) revert AlreadyProcessed(redemptionId);

        if (block.timestamp >= currentWindowStart + releaseWindowSeconds) {
            currentWindowStart = block.timestamp;
            currentWindowReleased = 0;
        }
        if (currentWindowReleased + amount > maxReleasePerWindow) {
            revert ReleaseExceedsWindowCap();
        }
        if (amount > totalReserve) revert InsufficientReserve();

        processedRedemptions[redemptionId] = true;
        currentWindowReleased += amount;
        totalReserve -= amount;
        usdc.safeTransfer(baseRecipient, amount);

        emit Released(redemptionId, arcTransactionHash, logIndex, baseRecipient, amount);
    }

    // ------------------------------------------------------------------- admin

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeAboveCap();
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setKeeper(address keeper, bool enabled) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        isKeeper[keeper] = enabled;
        emit KeeperUpdated(keeper, enabled);
    }

    function setDepositLimits(uint256 newMinDeposit, uint256 newMaxDeposit) external onlyOwner {
        if (newMinDeposit > newMaxDeposit) revert AmountOutOfRange();
        minDeposit = newMinDeposit;
        maxDeposit = newMaxDeposit;
        emit DepositLimitsUpdated(newMinDeposit, newMaxDeposit);
    }

    function setReleaseLimits(
        uint256 newMaxReleasePerTx,
        uint256 newMaxReleasePerWindow,
        uint256 newReleaseWindowSeconds
    ) external onlyOwner {
        maxReleasePerTx = newMaxReleasePerTx;
        maxReleasePerWindow = newMaxReleasePerWindow;
        releaseWindowSeconds = newReleaseWindowSeconds;
        emit ReleaseLimitsUpdated(
            newMaxReleasePerTx, newMaxReleasePerWindow, newReleaseWindowSeconds
        );
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    function setReleasesPaused(bool paused) external onlyOwner {
        releasesPaused = paused;
        emit ReleasesPausedSet(paused);
    }

    function setMigrationTarget(address newTarget) external onlyOwner {
        emit MigrationTargetUpdated(migrationTarget, newTarget);
        migrationTarget = newTarget;
    }

    /// @notice Move reserve to the configured migration target. Publicly
    ///         visible, only while both directions are paused, and only to the
    ///         pre-announced target — parity with the documented Envelope
    ///         policy and the sole path that moves reserve besides releases.
    function migrateReserve(uint256 amount) external onlyOwner nonReentrant {
        if (migrationTarget == address(0)) revert MigrationNotConfigured();
        if (!depositsPaused || !releasesPaused) revert MigrationRequiresPause();
        if (amount > totalReserve) revert InsufficientReserve();
        totalReserve -= amount;
        usdc.safeTransfer(migrationTarget, amount);
        emit ReserveMigrated(migrationTarget, amount);
    }

    /// @notice Rescue tokens sent here by mistake. The reserve asset is
    ///         excluded entirely — USDC can never leave through this path.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(usdc)) revert CannotRescueReserveAsset();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
