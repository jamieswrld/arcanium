// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IXCreatorVaultFactory {
    function attestationSigner() external view returns (address);
}

/// @title X creator vault
/// @notice Holds a token's creator-fee stream for an X account whose wallet is
///         not known at launch, and releases it to whoever proves they control
///         that X account.
///
/// @dev    Deployed as a minimal proxy at a CREATE2 address derived from the X
///         identity and the token. That matters: the address can be computed
///         before the contract exists, so a launch can route creator fees to it
///         immediately and the vault itself is only deployed when somebody
///         actually claims. An ERC-20 balance at an address with no code is
///         perfectly ordinary, and the existing fee distributor needs no
///         changes — it sees a normal EVM recipient.
///
///         The identity is a hash of X's stable *numeric* user ID, never the
///         username. Usernames are mutable and reusable; funds keyed off one
///         would follow whoever held the handle today rather than the person
///         who launched the token.
///
///         TRUST BOUNDARY, stated plainly: proving control of an X account is
///         not something a chain can do. The vault verifies an EIP-712
///         attestation from a signer that Arcanium operates, and that signer
///         decides which wallet a given X identity maps to. A dishonest or
///         compromised signer could attest a wallet it controls. What the
///         design does buy:
///
///           - the signer cannot move funds by itself; a claim must be sent by
///             the recipient named in the attestation, so a leaked signature
///             cannot be redirected;
///           - every release is an event naming the identity and recipient, so
///             misuse is visible rather than silent;
///           - the signer is read from the factory at claim time, so a
///             compromised key can be rotated without redeploying vaults or
///             moving anyone's funds.
///
///         This is not trustless and the docs must not claim it is.
contract XCreatorVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(bytes32 xUserIdHash,address vault,address token,address recipient,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ArcaniumXCreatorVault");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @notice keccak256 of the X account's stable numeric user ID, as ASCII.
    bytes32 public xUserIdHash;
    /// @notice The launch whose creator fees this vault receives.
    address public token;
    /// @notice The factory, which is where the current attestation signer lives.
    address public factory;

    /// @notice Consumed attestation nonces. Per vault, so a nonce burned here
    ///         says nothing about any other vault.
    mapping(uint256 => bool) public nonceUsed;

    event Claimed(
        bytes32 indexed xUserIdHash,
        address indexed recipient,
        address indexed asset,
        uint256 amount,
        uint256 nonce
    );

    error AlreadyInitialised();
    error ZeroIdentity();
    error ZeroAddressArg();
    error NotRecipient();
    error AttestationExpired();
    error NonceAlreadyUsed();
    error WrongVault();
    error WrongIdentity();
    error WrongToken();
    error BadSigner();
    error NothingToClaim();

    /// @dev Called once by the factory immediately after cloning. The
    ///      implementation copy is left uninitialised on purpose — it holds no
    ///      funds and every real vault is a proxy.
    function initialize(bytes32 xUserIdHash_, address token_, address factory_) external {
        if (factory != address(0)) revert AlreadyInitialised();
        if (xUserIdHash_ == bytes32(0)) revert ZeroIdentity();
        if (token_ == address(0) || factory_ == address(0)) revert ZeroAddressArg();
        xUserIdHash = xUserIdHash_;
        token = token_;
        factory = factory_;
    }

    /// @notice Release `asset` held by this vault to the attested recipient.
    /// @param asset      The ERC-20 to withdraw — creator fees arrive in the
    ///                   quote asset (USDC on Arc), but a vault can be swept of
    ///                   anything sent to it by the same proof.
    /// @param recipient  Wallet named in the attestation. Must be the caller.
    /// @param nonce      Single-use, per vault.
    /// @param deadline   Unix seconds after which the attestation is dead.
    /// @param signature  EIP-712 signature from the factory's current signer.
    function claim(
        address asset,
        address recipient,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        // The recipient must be the one asking. This is what stops a leaked or
        // intercepted attestation being replayed to a different wallet, and it
        // means the signer alone cannot drain a vault without also controlling
        // the wallet it attested.
        if (msg.sender != recipient) revert NotRecipient();
        if (recipient == address(0) || asset == address(0)) revert ZeroAddressArg();
        if (block.timestamp > deadline) revert AttestationExpired();
        if (nonceUsed[nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, xUserIdHash, address(this), asset, recipient, nonce, deadline)
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash);

        address signer = IXCreatorVaultFactory(factory).attestationSigner();
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != signer || signer == address(0)) revert BadSigner();

        uint256 amount = IERC20(asset).balanceOf(address(this));
        if (amount == 0) revert NothingToClaim();

        nonceUsed[nonce] = true;
        IERC20(asset).safeTransfer(recipient, amount);

        emit Claimed(xUserIdHash, recipient, asset, amount, nonce);
    }

    /// @notice Balance available to claim for an asset.
    function claimable(address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    /// @notice The EIP-712 domain separator for this vault.
    /// @dev Built at call time rather than cached in an immutable, because a
    ///      minimal proxy shares the implementation's immutables — a cached
    ///      separator would name the implementation as verifyingContract and be
    ///      identical across every vault, which is exactly the cross-vault
    ///      replay this is supposed to prevent. chainId is read live for the
    ///      same reason a fork must not inherit valid attestations.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }
}
