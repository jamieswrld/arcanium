import { keccak256, toBytes, type Hex } from "viem";

/**
 * The message a token's launcher signs to set its logo.
 *
 * The logo slot is otherwise first-writer-wins and unauthenticated, which was
 * safe only while the launch form always won the race within a second of the
 * launch. It did not win for the first Uniswap v4 launches — the form decoded
 * only v3's `Launched` event, so it never learned the token's address and
 * never wrote anything — and those slots have been sitting open ever since,
 * claimable by anyone who noticed.
 *
 * Signing closes that. The signature has to be worth exactly one write: the
 * message carries the token it applies to and a hash of the image being set,
 * so a signature captured in transit cannot be replayed to put a different
 * picture on the same token, or the same picture on a different one.
 *
 * It is a plain `personal_sign` rather than a transaction — no gas, no
 * approval, and nothing reaches the chain.
 */
export function logoMessage(token: string, metadataUri: string): string {
  return [
    "Arcanium — set token logo",
    `Token: ${token.toLowerCase()}`,
    `Image: ${keccak256(toBytes(metadataUri)) as Hex}`,
  ].join("\n");
}
