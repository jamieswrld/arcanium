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
/// @dev    Addresses are deterministic (CREATE2 over the X identity), which is
///         the point: a launch needs a fee recipient at creation time, and the
///         vault can be named then and deployed much later — only when somebody
///         claims. Until then it is an address with a balance and no code,
///         which every ERC-20 handles fine.
///
///         The salt is the identity and nothing else. Including the launch
///         token would make the address underivable at launch, since the token
///         does not exist until the factory mints it.
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
    event VaultDeployed(bytes32 indexed xUserIdHash, address vault);

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

    /// @notice Where this X account's creator fees live, deployed or not.
    /// @dev    Safe to use as a launch's fee recipient before deployment.
    function vaultFor(bytes32 xUserIdHash) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, xUserIdHash, address(this));
    }

    /// @notice Whether that vault has been deployed yet.
    function isDeployed(bytes32 xUserIdHash) external view returns (bool) {
        return vaultFor(xUserIdHash).code.length > 0;
    }

    /// @notice Deploy the vault. Idempotent: returns the existing one if it is
    ///         already there, so a claim flow can call this unconditionally.
    function deployVault(bytes32 xUserIdHash) external returns (address vault) {
        if (xUserIdHash == bytes32(0)) revert ZeroIdentity();

        vault = vaultFor(xUserIdHash);
        if (vault.code.length > 0) return vault;

        vault = Clones.cloneDeterministic(implementation, xUserIdHash);
        XCreatorVault(vault).initialize(xUserIdHash, address(this));
        emit VaultDeployed(xUserIdHash, vault);
    }
}
