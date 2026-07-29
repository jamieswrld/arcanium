import { encodeAbiParameters, keccak256, type Hex } from "viem";

/**
 * Deterministic bridge action identity: keccak256(abi.encode(txHash, logIndex))
 * of the originating event. Must match the on-chain computation in
 * ArchBridgeArc.mintDeposit and ArchVaultBase.release exactly — the contracts'
 * processed-ID mappings are the final replay barrier.
 */
export function bridgeActionId(sourceTxHash: Hex, logIndex: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [sourceTxHash, logIndex],
    ),
  );
}

export type BridgeActionState =
  | "awaiting_source_transaction"
  | "source_pending"
  | "source_confirmed"
  | "destination_submitted"
  | "destination_confirmed"
  | "completed"
  | "failed_retryable"
  | "failed_terminal"
  | "reorg_detected"
  | "paused";
