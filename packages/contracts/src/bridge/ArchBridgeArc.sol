// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ArchUSD} from "./ArchUSD.sol";

/// @title Arch bridge (Arc side)
/// @notice The only holder of aUSD's BRIDGE_ROLE. Mints exactly the net
///         amount of confirmed Base deposits (keeper-driven, replay-proof,
///         rate-capped) and burns aUSD for free one-for-one redemptions back
///         to Base USDC.
contract ArchBridgeArc is Ownable2Step, ReentrancyGuard {
    ArchUSD public immutable ausd;

    mapping(address => bool) public isKeeper;

    /// @notice Minimum redemption size (6-decimal units).
    uint256 public minRedeem;
    /// @notice Monotonic redemption sequence, part of each burn's identity.
    uint256 public redeemNonce;

    bool public mintsPaused;
    bool public redeemsPaused;

    uint256 public maxMintPerTx;
    uint256 public maxMintPerWindow;
    uint256 public mintWindowSeconds;
    uint256 public currentWindowStart;
    uint256 public currentWindowMinted;

    /// @notice Deposit action ids (keccak256(abi.encode(baseTxHash, logIndex)))
    ///         already minted. One deposit can never mint twice.
    mapping(bytes32 => bool) public processedDeposits;

    event DepositMinted(
        bytes32 indexed actionId,
        bytes32 baseTransactionHash,
        uint256 logIndex,
        address indexed recipient,
        uint256 netAmount
    );
    event Redeemed(
        address indexed sender,
        address indexed baseRecipient,
        uint256 amount,
        uint256 nonce
    );
    event KeeperUpdated(address indexed keeper, bool enabled);
    event MinRedeemUpdated(uint256 oldMinRedeem, uint256 newMinRedeem);
    event MintsPausedSet(bool paused);
    event RedeemsPausedSet(bool paused);
    event MintLimitsUpdated(
        uint256 maxMintPerTx, uint256 maxMintPerWindow, uint256 mintWindowSeconds
    );

    error NotKeeper();
    error MintsArePaused();
    error RedeemsArePaused();
    error ZeroAddress();
    error BelowMinRedeem();
    error AlreadyProcessed(bytes32 actionId);
    error MintExceedsTxCap();
    error MintExceedsWindowCap();

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    constructor(
        address ausd_,
        address owner_,
        uint256 minRedeem_,
        uint256 maxMintPerTx_,
        uint256 maxMintPerWindow_,
        uint256 mintWindowSeconds_
    ) Ownable(owner_) {
        if (ausd_ == address(0)) revert ZeroAddress();
        ausd = ArchUSD(ausd_);
        minRedeem = minRedeem_;
        maxMintPerTx = maxMintPerTx_;
        maxMintPerWindow = maxMintPerWindow_;
        mintWindowSeconds = mintWindowSeconds_;
        currentWindowStart = block.timestamp;
    }

    // -------------------------------------------------------------- redemption

    /// @notice Burn aUSD to receive USDC one-for-one on Base at
    ///         `baseRecipient`. Free apart from ordinary gas: burning 100 aUSD
    ///         releases exactly 100 USDC once the burn is final.
    function redeem(uint256 amount, address baseRecipient) external nonReentrant {
        if (redeemsPaused) revert RedeemsArePaused();
        if (baseRecipient == address(0)) revert ZeroAddress();
        if (amount < minRedeem) revert BelowMinRedeem();

        // Only msg.sender's own balance can ever be burned.
        ausd.bridgeBurn(msg.sender, amount);

        uint256 nonce = redeemNonce++;
        emit Redeemed(msg.sender, baseRecipient, amount, nonce);
    }

    // ------------------------------------------------------------------ mints

    /// @notice Mint the net amount of a Base deposit once it is confirmation-
    ///         deep. Keeper-driven; the action id makes replays impossible
    ///         on-chain regardless of worker behavior.
    function mintDeposit(
        bytes32 baseTransactionHash,
        uint256 logIndex,
        address recipient,
        uint256 netAmount
    ) external onlyKeeper nonReentrant {
        if (mintsPaused) revert MintsArePaused();
        if (recipient == address(0)) revert ZeroAddress();
        if (netAmount > maxMintPerTx) revert MintExceedsTxCap();

        bytes32 actionId = keccak256(abi.encode(baseTransactionHash, logIndex));
        if (processedDeposits[actionId]) revert AlreadyProcessed(actionId);

        if (block.timestamp >= currentWindowStart + mintWindowSeconds) {
            currentWindowStart = block.timestamp;
            currentWindowMinted = 0;
        }
        if (currentWindowMinted + netAmount > maxMintPerWindow) {
            revert MintExceedsWindowCap();
        }

        processedDeposits[actionId] = true;
        currentWindowMinted += netAmount;
        ausd.bridgeMint(recipient, netAmount);

        emit DepositMinted(actionId, baseTransactionHash, logIndex, recipient, netAmount);
    }

    // ------------------------------------------------------------------- admin

    function setKeeper(address keeper, bool enabled) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        isKeeper[keeper] = enabled;
        emit KeeperUpdated(keeper, enabled);
    }

    function setMinRedeem(uint256 newMinRedeem) external onlyOwner {
        emit MinRedeemUpdated(minRedeem, newMinRedeem);
        minRedeem = newMinRedeem;
    }

    function setMintsPaused(bool paused) external onlyOwner {
        mintsPaused = paused;
        emit MintsPausedSet(paused);
    }

    function setRedeemsPaused(bool paused) external onlyOwner {
        redeemsPaused = paused;
        emit RedeemsPausedSet(paused);
    }

    function setMintLimits(
        uint256 newMaxMintPerTx,
        uint256 newMaxMintPerWindow,
        uint256 newMintWindowSeconds
    ) external onlyOwner {
        maxMintPerTx = newMaxMintPerTx;
        maxMintPerWindow = newMaxMintPerWindow;
        mintWindowSeconds = newMintWindowSeconds;
        emit MintLimitsUpdated(newMaxMintPerTx, newMaxMintPerWindow, newMintWindowSeconds);
    }
}
