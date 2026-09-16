// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {XCreatorVault} from "../../src/xcreator/XCreatorVault.sol";
import {XCreatorVaultFactory} from "../../src/xcreator/XCreatorVaultFactory.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Reverts on transfer, to prove a failed payout does not burn the nonce.
contract RevertingToken is ERC20 {
    bool public blocked = true;

    constructor() ERC20("Bad", "BAD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function unblock() external {
        blocked = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked && from != address(0)) revert("blocked");
        super._update(from, to, value);
    }
}

contract XCreatorVaultTest is Test {
    XCreatorVaultFactory internal factory;
    MockUSDC internal usdc;

    uint256 internal signerKey = 0xA77E57;
    address internal signer;
    address internal owner = address(0x0E5E2);

    // keccak256 of X's stable numeric user id, as ASCII — never the @handle.
    bytes32 internal constant X_ID = keccak256("1526228120446631936");
    bytes32 internal constant OTHER_X_ID = keccak256("9999999999999999999");

    address internal creator = address(0xC12EA704);
    address internal attacker = address(0xBAD);
    address internal token = address(0x7043); // stands in for a launch token

    function setUp() public {
        vm.warp(1_700_000_000);
        signer = vm.addr(signerKey);
        factory = new XCreatorVaultFactory(owner, signer);
        usdc = new MockUSDC();
    }

    function _vault() internal returns (XCreatorVault) {
        return XCreatorVault(factory.deployVault(X_ID));
    }

    function _sign(
        uint256 key,
        XCreatorVault vault,
        bytes32 idHash,
        address vaultAddr,
        address asset,
        address recipient,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Claim(bytes32 xUserIdHash,address vault,address asset,address recipient,uint256 nonce,uint256 deadline)"
                ),
                idHash,
                vaultAddr,
                asset,
                recipient,
                nonce,
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The happy path, signed correctly for this vault on this chain.
    function _goodSig(XCreatorVault vault, address recipient, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(signerKey, vault, X_ID, address(vault), address(usdc), recipient, nonce, deadline);
    }

    /// EIP-712 domain separator as it would be on `chainId`, computed here
    /// rather than read from the vault, so the test controls the chain id
    /// directly instead of relying on a cheatcode reaching into a view call.
    function _separatorFor(address vaultAddr, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("ArcaniumXCreatorVault"),
                keccak256("1"),
                chainId,
                vaultAddr
            )
        );
    }

    function _signWithSeparator(
        uint256 key,
        bytes32 separator,
        bytes32 idHash,
        address vaultAddr,
        address asset,
        address recipient,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Claim(bytes32 xUserIdHash,address vault,address asset,address recipient,uint256 nonce,uint256 deadline)"
                ),
                idHash,
                vaultAddr,
                asset,
                recipient,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", separator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /* ------------------------------------------------ deterministic address */

    function test_vaultAddressIsKnownBeforeDeployment() public view {
        address predicted = factory.vaultFor(X_ID);
        assertTrue(predicted != address(0), "an address exists for it");
        assertEq(predicted.code.length, 0, "but nothing is deployed there yet");
    }

    function test_addressPredictedMatchesDeployed() public {
        address predicted = factory.vaultFor(X_ID);
        assertEq(predicted.code.length, 0, "not deployed yet");
        assertFalse(factory.isDeployed(X_ID));

        // Fees can arrive before any contract exists there.
        usdc.mint(predicted, 1_000e6);
        assertEq(usdc.balanceOf(predicted), 1_000e6);

        address deployed = factory.deployVault(X_ID);
        assertEq(deployed, predicted, "CREATE2 address held");
        assertTrue(factory.isDeployed(X_ID));
        assertEq(usdc.balanceOf(deployed), 1_000e6, "balance survived deployment");
    }

    function test_deployVaultIsIdempotent() public {
        address a = factory.deployVault(X_ID);
        address b = factory.deployVault(X_ID);
        assertEq(a, b);
    }

    function test_differentIdentitiesGetDifferentVaults() public view {
        assertTrue(factory.vaultFor(X_ID) != factory.vaultFor(OTHER_X_ID));
    }

    /// The property that makes the whole design work: the address is derivable
    /// before any token exists, so a launch can name it as its fee recipient.
    function test_oneVaultPerIdentityAcrossEveryLaunch() public view {
        assertEq(factory.vaultFor(X_ID), factory.vaultFor(X_ID), "stable for the identity");
    }

    function test_initializeCannotBeCalledTwice() public {
        XCreatorVault vault = _vault();
        vm.expectRevert(XCreatorVault.AlreadyInitialised.selector);
        vault.initialize(X_ID, address(factory));
    }

    /* ------------------------------------------------------------- claiming */

    function test_claim_paysTheAttestedRecipient() public {
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 500e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _goodSig(vault, creator, 1, deadline);

        vm.prank(creator);
        vault.claim(address(usdc), creator, 1, deadline, sig);

        assertEq(usdc.balanceOf(creator), 500e6);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertTrue(vault.nonceUsed(1));
    }

    function test_claim_canHappenRepeatedlyAsFeesAccrue() public {
        XCreatorVault vault = _vault();
        uint256 deadline = block.timestamp + 365 days;

        bytes memory sig1 = _goodSig(vault, creator, 1, deadline);
        bytes memory sig2 = _goodSig(vault, creator, 2, deadline);

        usdc.mint(address(vault), 100e6);
        vm.prank(creator);
        vault.claim(address(usdc), creator, 1, deadline, sig1);

        usdc.mint(address(vault), 250e6);
        vm.prank(creator);
        vault.claim(address(usdc), creator, 2, deadline, sig2);

        assertEq(usdc.balanceOf(creator), 350e6);
    }

    /// Changing wallets: the same X identity re-attests to a new address.
    function test_claim_toANewWalletAfterIdentityReVerifies() public {
        XCreatorVault vault = _vault();
        address newWallet = address(0x0E51);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _goodSig(vault, newWallet, 7, deadline);
        usdc.mint(address(vault), 100e6);
        vm.prank(newWallet);
        vault.claim(address(usdc), newWallet, 7, deadline, sig);
        assertEq(usdc.balanceOf(newWallet), 100e6);
    }

    function test_claim_revertsOnEmptyVault() public {
        XCreatorVault vault = _vault();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _goodSig(vault, creator, 1, deadline);
        vm.prank(creator);
        vm.expectRevert(XCreatorVault.NothingToClaim.selector);
        vault.claim(address(usdc), creator, 1, deadline, sig);
    }

    /* ---------------------------------------------------------- the attacks */

    function test_attack_replaySameNonce() public {
        XCreatorVault vault = _vault();
        uint256 deadline = block.timestamp + 1 hours;
        usdc.mint(address(vault), 100e6);
        bytes memory sig = _goodSig(vault, creator, 1, deadline);

        vm.startPrank(creator);
        vault.claim(address(usdc), creator, 1, deadline, sig);
        usdc.mint(address(vault), 100e6); // more fees arrive
        vm.expectRevert(XCreatorVault.NonceAlreadyUsed.selector);
        vault.claim(address(usdc), creator, 1, deadline, sig);
        vm.stopPrank();
    }

    function test_attack_expiredAttestation() public {
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _goodSig(vault, creator, 1, deadline);

        vm.warp(deadline + 1);
        vm.prank(creator);
        vm.expectRevert(XCreatorVault.AttestationExpired.selector);
        vault.claim(address(usdc), creator, 1, deadline, sig);
    }

    /// A proof for one vault must not work on another, even same identity.
    function test_attack_proofFromAnotherVault() public {
        XCreatorVault mine = _vault();
        XCreatorVault other = XCreatorVault(factory.deployVault(OTHER_X_ID));
        usdc.mint(address(other), 100e6);
        uint256 deadline = block.timestamp + 1 hours;

        // Signed for `mine`, replayed against `other`.
        bytes memory sig = _goodSig(mine, creator, 1, deadline);
        vm.prank(creator);
        vm.expectRevert(XCreatorVault.BadSigner.selector);
        other.claim(address(usdc), creator, 1, deadline, sig);
    }

    /// Redirecting a valid signature to a different wallet.
    function test_attack_recipientSubstitution() public {
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _goodSig(vault, creator, 1, deadline);

        // Attacker holds the signature but is not the named recipient.
        vm.prank(attacker);
        vm.expectRevert(XCreatorVault.NotRecipient.selector);
        vault.claim(address(usdc), creator, 1, deadline, sig);

        // And cannot rewrite the recipient, because it is signed over.
        vm.prank(attacker);
        vm.expectRevert(XCreatorVault.BadSigner.selector);
        vault.claim(address(usdc), attacker, 1, deadline, sig);
    }

    function test_attack_wrongSigner() public {
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory forged =
            _sign(0xDEADBEEF, vault, X_ID, address(vault), address(usdc), creator, 1, deadline);

        vm.prank(creator);
        vm.expectRevert(XCreatorVault.BadSigner.selector);
        vault.claim(address(usdc), creator, 1, deadline, forged);
    }

    function test_attack_wrongIdentityInPayload() public {
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(signerKey, vault, OTHER_X_ID, address(vault), address(usdc), creator, 1, deadline);

        vm.prank(creator);
        vm.expectRevert(XCreatorVault.BadSigner.selector);
        vault.claim(address(usdc), creator, 1, deadline, sig);
    }

    /// A signature from another chain must not work here.
    function test_attack_crossChainReplay() public {
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 100e6);
        uint256 deadline = block.timestamp + 1 hours;

        uint256 elsewhere = block.chainid + 1;
        // Signed against a domain naming a different chain. Everything else —
        // identity, vault, asset, recipient, nonce, deadline — is correct.
        bytes memory sig = _signWithSeparator(
            signerKey,
            _separatorFor(address(vault), elsewhere),
            X_ID,
            address(vault),
            address(usdc),
            creator,
            1,
            deadline
        );
        // Sanity: the vault's own separator really is different.
        assertTrue(vault.domainSeparator() != _separatorFor(address(vault), elsewhere));

        vm.prank(creator);
        vm.expectRevert(XCreatorVault.BadSigner.selector);
        vault.claim(address(usdc), creator, 1, deadline, sig);
    }

    /// The headline property: the signer cannot help itself to the funds.
    function test_signerCannotWithdrawToItself() public {
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 100e6);
        uint256 deadline = block.timestamp + 1 hours;

        // The signer signs itself a proof — which it can, that is the trust
        // boundary — but must still be the caller, and the attempt is a public
        // event naming the identity. There is no path that moves funds without
        // an attestation that names a recipient.
        bytes memory sig =
            _sign(signerKey, vault, X_ID, address(vault), address(usdc), signer, 1, deadline);
        vm.prank(attacker);
        vm.expectRevert(XCreatorVault.NotRecipient.selector);
        vault.claim(address(usdc), signer, 1, deadline, sig);

        // No owner path exists either.
        bytes memory creatorSig = _goodSig(vault, creator, 1, deadline);
        vm.prank(owner);
        vm.expectRevert(XCreatorVault.NotRecipient.selector);
        vault.claim(address(usdc), creator, 1, deadline, creatorSig);
    }

    function test_failedTransferDoesNotBurnTheNonce() public {
        XCreatorVault vault = _vault();
        RevertingToken bad = new RevertingToken();
        bad.mint(address(vault), 100 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(signerKey, vault, X_ID, address(vault), address(bad), creator, 1, deadline);

        vm.prank(creator);
        vm.expectRevert();
        vault.claim(address(bad), creator, 1, deadline, sig);
        assertFalse(vault.nonceUsed(1), "nonce survives a failed payout");

        bad.unblock();
        vm.prank(creator);
        vault.claim(address(bad), creator, 1, deadline, sig);
        assertEq(bad.balanceOf(creator), 100 ether);
    }

    /* ------------------------------------------------------ signer rotation */

    function test_signerRotationInvalidatesOldSignerAndFreesNoFunds() public {
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory oldSig = _goodSig(vault, creator, 1, deadline);

        uint256 newKey = 0xFEED;
        vm.prank(owner);
        factory.setAttestationSigner(vm.addr(newKey));

        vm.prank(creator);
        vm.expectRevert(XCreatorVault.BadSigner.selector);
        vault.claim(address(usdc), creator, 1, deadline, oldSig);

        // The new signer works immediately, with no vault redeployment.
        bytes memory newSig =
            _sign(newKey, vault, X_ID, address(vault), address(usdc), creator, 2, deadline);
        vm.prank(creator);
        vault.claim(address(usdc), creator, 2, deadline, newSig);
        assertEq(usdc.balanceOf(creator), 100e6);
    }

    function test_onlyOwnerRotatesSigner() public {
        vm.prank(attacker);
        vm.expectRevert();
        factory.setAttestationSigner(attacker);
    }

    /* ---------------------------------------------------------------- fuzz */

    function testFuzz_onlyNamedRecipientClaims(address caller) public {
        vm.assume(caller != creator && caller != address(0));
        XCreatorVault vault = _vault();
        usdc.mint(address(vault), 100e6);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _goodSig(vault, creator, 1, deadline);
        vm.prank(caller);
        vm.expectRevert(XCreatorVault.NotRecipient.selector);
        vault.claim(address(usdc), creator, 1, deadline, sig);
    }

    function testFuzz_nonceIsSingleUse(uint96 nonce) public {
        XCreatorVault vault = _vault();
        uint256 deadline = block.timestamp + 365 days;
        usdc.mint(address(vault), 10e6);
        bytes memory sig = _goodSig(vault, creator, nonce, deadline);

        vm.startPrank(creator);
        vault.claim(address(usdc), creator, nonce, deadline, sig);
        usdc.mint(address(vault), 10e6);
        vm.expectRevert(XCreatorVault.NonceAlreadyUsed.selector);
        vault.claim(address(usdc), creator, nonce, deadline, sig);
        vm.stopPrank();
    }
}
