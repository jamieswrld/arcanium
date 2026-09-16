import "server-only";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, type Hex } from "viem";
import { ARC_XCREATOR, ARC_CHAIN_ID } from "@arch/chain-config";

/**
 * The attestation signer.
 *
 * It signs one statement and nothing else: "the browser holding this session
 * proved control of X user N, and asked for the funds in vault V to go to
 * wallet W, before time T". The vault checks that signature and then checks
 * that the caller *is* W, so this key alone cannot move anyone's money — it
 * would also need the recipient's wallet.
 *
 * That is the honest boundary. A dishonest operator could sign an attestation
 * naming a wallet they control; what they cannot do is act silently, because
 * every release emits an event naming the identity and the recipient, and they
 * cannot redirect a claim after the fact, because the recipient is signed over.
 *
 * The key is read from server-only env at call time and never returned,
 * logged, or included in any response.
 */

const DOMAIN_NAME = "ArcaniumXCreatorVault";
const DOMAIN_VERSION = "1";

const CLAIM_TYPES = {
  Claim: [
    { name: "xUserIdHash", type: "bytes32" },
    { name: "vault", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** How long an attestation is good for. Short: it exists to be used once,
 *  immediately, by the person who just authenticated. */
const TTL_SECONDS = 10 * 60;

export interface Attestation {
  readonly signature: Hex;
  readonly xUserIdHash: Hex;
  readonly vault: Hex;
  readonly token: Hex;
  readonly recipient: Hex;
  readonly nonce: string;
  readonly deadline: number;
  readonly signer: Hex;
  readonly chainId: number;
}

export function attestationSignerAddress(): Hex | null {
  const key = process.env["X_ATTESTATION_SIGNER_KEY"];
  if (key === undefined || key.trim() === "") return null;
  try {
    return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex).address;
  } catch {
    return null;
  }
}

/**
 * Sign a claim authorisation.
 *
 * The nonce is random rather than sequential. A counter would need shared state
 * across serverless invocations to avoid collisions, and the vault only cares
 * that a nonce is unused — 128 bits of randomness makes a collision less likely
 * than the key leaking.
 */
export async function signClaim(args: {
  readonly xUserIdHash: Hex;
  readonly vault: Hex;
  readonly token: Hex;
  readonly recipient: Hex;
}): Promise<Attestation | null> {
  const key = process.env["X_ATTESTATION_SIGNER_KEY"];
  if (key === undefined || key.trim() === "") return null;

  let account;
  try {
    account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  } catch {
    return null;
  }

  // Refuse to sign for the wrong signer: if the deployed factory expects a
  // different address, a signature from this key is worthless and producing it
  // would just fail confusingly at the vault.
  if (account.address.toLowerCase() !== ARC_XCREATOR.attestationSigner.toLowerCase()) {
    return null;
  }

  const nonce = BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`);
  const deadline = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  const signature = await account.signTypedData({
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: ARC_CHAIN_ID,
      // The vault itself, so a signature for one vault is meaningless at any
      // other — the single most important field here.
      verifyingContract: getAddress(args.vault),
    },
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: {
      xUserIdHash: args.xUserIdHash,
      vault: getAddress(args.vault),
      token: getAddress(args.token),
      recipient: getAddress(args.recipient),
      nonce,
      deadline: BigInt(deadline),
    },
  });

  return {
    signature,
    xUserIdHash: args.xUserIdHash,
    vault: getAddress(args.vault),
    token: getAddress(args.token),
    recipient: getAddress(args.recipient),
    nonce: nonce.toString(),
    deadline,
    signer: account.address,
    chainId: ARC_CHAIN_ID,
  };
}
