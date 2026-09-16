import type { ReactNode } from "react";
import { BRIDGE_CHAINS } from "@/lib/bridgeChains";

/**
 * Bridge documentation.
 *
 * The bridge had none, which was the largest undocumented surface in the
 * product: it moves real money across twelve chains and the one thing people
 * most need to know about it — that Arcanium never holds the funds — was only
 * visible to someone reading the source.
 *
 * The chain table is generated from the same module the bridge itself uses, so
 * a chain added to the product cannot go missing from its documentation, and
 * the documented list cannot drift into claiming a route that does not exist.
 */

function Mono({ children }: { readonly children: ReactNode }) {
  return <code className="docs-mono">{children}</code>;
}

function Callout({ children }: { readonly children: ReactNode }) {
  return <div className="docs-callout">{children}</div>;
}

export const BRIDGE_DOCS: Record<string, ReactNode> = {
  bridge: (
    <>
      <h1>Bridging USDC</h1>
      <p className="docs-lead">
        Move native USDC between Arc and eleven other chains. The USDC is burned on the chain it
        leaves and minted on the chain it arrives at, so what lands is real USDC and not a wrapped
        claim on somebody&apos;s reserve.
      </p>

      <h2>What is actually happening</h2>
      <p>
        This is Circle&apos;s CCTP v2. There is no pool of deposits, no wrapped asset, and no
        Arcanium custody at any point. Your USDC is destroyed on the source chain, Circle observes
        that and signs an attestation, and that attestation lets the destination chain mint the same
        amount to you.
      </p>
      <Callout>
        Arcanium never holds your money during a transfer. This is the only reason supporting a
        dozen chains is a configuration problem rather than a security one — a bridge that holds
        funds is the most attacked kind of contract in this industry, and this is not one.
      </Callout>

      <h2>The steps</h2>
      <ol>
        <li>
          <strong>Approve</strong> — a one-time allowance on the source chain, so the deposit
          contract can take the amount you named. Skipped if you have one already.
        </li>
        <li>
          <strong>Deposit</strong> — your USDC is burned. This is the transaction that moves money.
        </li>
        <li>
          <strong>Wait for Circle</strong> — Circle signs the deposit. How long this takes is set by
          Circle, not by Arcanium, and it differs by source chain.
        </li>
        <li>
          <strong>Claim</strong> — the mint on the destination chain. Arcanium relays this for you,
          so arriving on a chain where you hold no gas still works.
        </li>
      </ol>

      <h2>Closing the tab</h2>
      <p>
        A transfer in flight is saved in your browser, so closing the tab or losing connection does
        not lose it — reopening the bridge picks the same transfer back up at the step it reached.
        The claim can always be re-attempted and never creates a second deposit.
      </p>
      <p>
        Even if this site were unavailable, a burned deposit is not stuck. The attestation is
        Circle&apos;s and the mint is a public contract call, so the funds can be claimed by anyone
        able to reach the destination chain, including you directly.
      </p>

      <h2>What you receive</h2>
      <p>
        The amount shown as <em>You receive (at least)</em> is what arrives, net of everything. It
        is a minimum rather than an estimate because Circle&apos;s fast-lane fee is a ceiling you
        authorise rather than a fixed price — if the real fee comes in lower, more arrives than the
        figure promised, never less.
      </p>

      <h2>Limits</h2>
      <p>
        Circle enforces a per-transfer ceiling on some routes, and it is enforced on the chain, not
        by us. Where one applies, the bridge shows it before you sign rather than letting the
        deposit fail. Withdrawals from Arc are the route most often limited.
      </p>
    </>
  ),

  "bridge/chains": (
    <>
      <h1>Supported chains</h1>
      <p className="docs-lead">
        Every route below moves native USDC in both directions, to and from Arc.
      </p>

      <table className="docs-table">
        <thead>
          <tr>
            <th>Chain</th>
            <th>Chain ID</th>
            <th>CCTP domain</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Arc</td>
            <td>5042</td>
            <td>26</td>
          </tr>
          {BRIDGE_CHAINS.map((c) => (
            <tr key={c.key}>
              <td>{c.name}</td>
              <td>{c.chainId}</td>
              <td>{c.domain}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        The CCTP domain is Circle&apos;s own identifier and is unrelated to the EIP-155 chain ID.
        Integrators need the domain, not the chain ID, when constructing a transfer.
      </p>

      <h2>What is deliberately missing</h2>
      <p>
        <strong>BNB Smart Chain.</strong> CCTP lists a domain for it, but Circle does not issue
        native USDC there — the common BNB &ldquo;USDC&rdquo; is a Binance-pegged bridged asset,
        which is a different thing and not what this moves. Listing it would offer a route that
        cannot work.
      </p>
      <p>
        <strong>Solana.</strong> CCTP supports it, but it is not an EVM chain, so it needs a
        different wallet connection and transaction format rather than another row in this table.
        It is a real piece of work, not an oversight.
      </p>

      <Callout>
        Every address behind these routes — the USDC contract, the TokenMessenger and the
        MessageTransmitter — was confirmed to have code on that network before the chain was added.
        None of it was copied from documentation and trusted.
      </Callout>

      <h2>Arriving with no gas</h2>
      <p>
        Bridging into Arc does not require you to already hold Arc gas. Arcanium relays the claim,
        which is what makes Arc reachable for somebody who has never held anything on it. On Arc,
        USDC <em>is</em> the gas token — see <Mono>Getting USDC on Arc</Mono> — so once the transfer
        lands you can trade immediately.
      </p>
    </>
  ),
};
