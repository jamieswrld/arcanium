import Link from "next/link";
import { profileUrl, vaultOwner } from "@/lib/socialVaults";
import { explorerAddress, getChain } from "@/lib/chains";
import { CopyButton } from "@/components/CopyButton";
import { arcPublicClient, launchTokenAbi } from "@/lib/launchpad";
import type { Hex } from "viem";

/**
 * The terms a token launched with, stated plainly.
 *
 * All of this is fixed at launch and can never change, which is the reason it
 * is worth a permanent place on the page rather than a tooltip: it is the part
 * of a market a buyer cannot renegotiate. Reward mode, trade tax and who
 * collects the creator's share are decided once, by the creator, before anyone
 * else can act on them.
 *
 * The fee recipient is the one field that needs work to be useful. When it is
 * a social vault the address alone says nothing — a hash does not run
 * backwards — so it is looked up and shown as the account, linked. When it is
 * not recognised it is shown as an address, never guessed at: attributing a
 * fee stream to the wrong account would be worse than showing hex.
 */

const MODES = [
  { label: "Standard", detail: "Creator fees paid to the recipient in USDC." },
  { label: "Divium", detail: "Creator fees paid out to holders, in USDC." },
  { label: "Arcane", detail: "Creator fees buy the token and burn it." },
] as const;

function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="ls-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export async function LaunchSettings({
  token,
  feeRecipient,
  mode,
  protocol,
}: {
  readonly token: string;
  /**
   * Who collects the creator's share.
   *
   * This is the factory's `creator` field, which is misleadingly named: it
   * stores `params.feeRecipient` when one was given and the launching wallet
   * otherwise. So it is the reward wallet, and is labelled as such here rather
   * than presented as "the creator", which it need not be.
   */
  readonly feeRecipient: string;
  readonly mode: number | null;
  readonly protocol: "v3" | "v4";
}) {
  const chain = getChain("arc");
  const [owner, taxBps] = await Promise.all([
    vaultOwner(feeRecipient),
    arcPublicClient()
      .readContract({ address: token as Hex, abi: launchTokenAbi, functionName: "taxBps" })
      .then((v) => Number(v))
      // Tokens from before the tax existed do not implement it. That is not an
      // error and not a tax; both resolve to "none".
      .catch(() => 0),
  ]);
  const m = mode === null ? null : MODES[mode] ?? null;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="eyebrow">Launch terms</span>
        <span className="arch-note" style={{ fontSize: "0.72rem" }}>fixed at launch</span>
      </div>
      <dl className="ls-grid">
        <Row label="Reward mode">
          {m === null ? (
            <span className="arch-note">Pre-dates reward modes</span>
          ) : (
            <>
              <strong>{m.label}</strong>
              <span className="arch-note" style={{ display: "block" }}>{m.detail}</span>
            </>
          )}
        </Row>

        <Row label="Trade tax">
          {taxBps === null || taxBps === 0 ? (
            <>
              <strong>None</strong>
              <span className="arch-note" style={{ display: "block" }}>
                Only the 1% pool fee. Transfers are untaxed.
              </span>
            </>
          ) : (
            <>
              <strong>{(taxBps / 100).toFixed(2)}%</strong>
              <span className="arch-note" style={{ display: "block" }}>
                Charged on every buy and sell, on top of the 1% fee.
              </span>
            </>
          )}
        </Row>

        <Row label="Pool">
          <strong>Uniswap {protocol}</strong>
          <span className="arch-note" style={{ display: "block" }}>
            {protocol === "v4"
              ? "Fees settle inside each trade. Liquidity held by a contract with no withdrawal."
              : "1% fee tier. Liquidity locked in the Arcanium vault."}
          </span>
        </Row>

        <Row label="Creator fees to">
          {owner !== null ? (
            <>
              <a href={profileUrl(owner.platform, owner.handle)} target="_blank" rel="noreferrer">
                {owner.platform === "github" ? owner.handle : `@${owner.handle}`} ↗
              </a>
              <span className="arch-note" style={{ display: "block" }}>
                {owner.platform === "github" ? "GitHub" : "X"} account · claimed from the vault at{" "}
                <span className="mono">{feeRecipient?.slice(0, 10)}…</span>
              </span>
            </>
          ) : (
            <span className="row" style={{ gap: "var(--s2)", flexWrap: "wrap" }}>
              <a
                href={explorerAddress(chain, feeRecipient)}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {feeRecipient.slice(0, 10)}…{feeRecipient.slice(-6)} ↗
              </a>
              <CopyButton text={feeRecipient} label="Copy fee recipient" />
            </span>
          )}
        </Row>

      </dl>
    </section>
  );
}
