import { pad, type Hex } from "viem";

/**
 * Circle CCTP v2 constants for the Base ↔ Arc USDC bridge. Contract addresses
 * are Circle's canonical CREATE2 deployments (verified live on both chains);
 * burning on the source chain mints native USDC on the destination after
 * Circle's attestation. Arc's domain (26) was read from the on-chain
 * MessageTransmitter.
 */

export const TOKEN_MESSENGER_V2: Hex = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const MESSAGE_TRANSMITTER_V2: Hex = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

export const BASE_DOMAIN = 6;
export const ARC_DOMAIN = 26;

export const BASE_USDC: Hex = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const ARC_USDC: Hex = "0x3600000000000000000000000000000000000000";

/** Fast-transfer finality threshold (soft finality, seconds-fast). */
export const FAST_FINALITY = 1000;
/** Fee cap for fast transfers: 20 bps ceiling — actual charged fee is lower. */
export function maxFeeFor(amount: bigint): bigint {
  const cap = (amount * 20n) / 10_000n;
  return cap > 0n ? cap : 1n;
}

export function addressToBytes32(address: Hex): Hex {
  return pad(address, { size: 32 });
}

export const tokenMessengerAbi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

export const messageTransmitterAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
