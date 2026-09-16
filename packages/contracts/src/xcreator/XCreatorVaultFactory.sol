// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {XCreatorVault} from "./XCreatorVault.sol";

/// @title X creator vault factory
/// @notice Computes and deploys the vault that receives a token's creator fees
///         on behalf of an X account.
///
/// @dev    Addresses are deterministic (CREATE2 over the identity and token),
///         which is the point: a launch needs a fee recipient at creation time,
///         and the vault can be named then and deployed much later — only when
///         somebody claims. Until then it is an address with a balance and no
///         code, which every ERC-20 handles fine.
///
///         The owner's only power is rotating the attestation signer. It cannot
///         touch a vault's funds, cannot re-point an existing vault at a
///         different identity, and cannot stop a claim. Rotation exists because
///         the signer is an operational key: if it leaks, the fix must not
///         require moving anyone's money.
contract XCreatorVaultFactory is Ownable2Step {
    /// @notice The logic every vault proxies to.
    address public immutable implementation;

    /// @notice Signer whose EIP-712 attestations vaults accept. See the trust
    ///         boundary note in XCreatorVault.
    address public attestationSigner;

    event AttestationSignerUpdated(address indexed previous, address indexed current);
    event VaultDeployed(bytes32 indexed xUserIdHash, address indexed token, address vault);

    error ZeroAddress();
    error ZeroIdentity();

    constructor(address owner_, address attestationSigner_) Ownable(owner_) {
        if (attestationSigner_ == address(0)) revert ZeroAddress();
        implementation = address(new XCreatorVault());
        attestationSigner = attestationSigner_;
        emit AttestationSignerUpdated(address(0), attestationSigner_);
    }

    /// @notice Rotate the attestation signer. Affects every vault at once,
    ///         since vaults read this at claim time rather than caching it.
    function setAttestationSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        emit AttestationSignerUpdated(attestationSigner, signer);
        attestationSigner = signer;
    }

    /// @notice Where the vault for this identity and token lives, deployed or not.
    /// @dev    Safe to use as a launch's fee recipient before deployment.
    function vaultFor(bytes32 xUserIdHash, address token) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(xUserIdHash, token), address(this));
    }

    /// @notice Whether that vault has been deployed yet.
    function isDeployed(bytes32 xUserIdHash, address token) external view returns (bool) {
        return vaultFor(xUserIdHash, token).code.length > 0;
    }

    /// @notice Deploy the vault. Idempotent: returns the existing one if it is
    ///         already there, so a claim flow can call this unconditionally.
    function deployVault(bytes32 xUserIdHash, address token) external returns (address vault) {
        if (xUserIdHash == bytes32(0)) revert ZeroIdentity();
        if (token == address(0)) revert ZeroAddress();

        vault = vaultFor(xUserIdHash, token);
        if (vault.code.length > 0) return vault;

        vault = Clones.cloneDeterministic(implementation, _salt(xUserIdHash, token));
        XCreatorVault(vault).initialize(xUserIdHash, token, address(this));
        emit VaultDeployed(xUserIdHash, token, vault);
    }

    /// @dev Both inputs in the salt, so one X identity gets a separate vault per
    ///      launch. Mixing every token into one vault would make a single
    ///      attestation sweep unrelated launches' fees together.
    function _salt(bytes32 xUserIdHash, address token) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(xUserIdHash, token));
    }
}
