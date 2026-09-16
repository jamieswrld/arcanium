import type { ReactNode } from "react";

/**
 * Why Arcanium tokens carry no transfer tax.
 *
 * This page previously documented a tax creators could set. That was withdrawn
 * once it turned out a token carrying one cannot be sold at all — so the page
 * now documents the restriction rather than the feature.
 *
 * It is worth its own page rather than a footnote because it is the single
 * most useful thing to be able to point a scanner, a terminal or a sceptical
 * trader at. "No transfer tax" is the claim that distinguishes our tokens from
 * the honeypots they get mistaken for.
 */

function Callout({ children }: { readonly children: ReactNode }) {
  return <div className="docs-callout">{children}</div>;
}

export const TAX_DOCS: Record<string, ReactNode> = {
  "launchpad/tax": (
    <>
      <h1>No transfer tax</h1>
      <p className="docs-lead">
        No token launched on Arcanium taxes its own transfers. Not on buys, not on sells, not on
        sending it to a friend. The launch form and the API both refuse to set one.
      </p>

      <h2>Why it is refused rather than simply unused</h2>
      <p>
        A token that taxes its own transfers cannot be sold on Uniswap v3. A sell delivers its input
        to the pool as an ordinary transfer, and the pool then checks that it received the amount it
        was promised. A tax skims exactly that transfer, so the pool comes up short and the trade
        reverts.
      </p>
      <p>
        The buy still works, which is what makes it dangerous: the token looks fine until somebody
        tries to get out. That is the textbook definition of a honeypot, and a launchpad that
        offered the setting would be a machine for producing them. So the option is not offered.
      </p>

      <Callout>
        This is checkable rather than a promise. Read <code className="docs-mono">taxBps()</code> on
        any Arcanium token and it returns <code className="docs-mono">0</code>; tokens from the
        earliest factories do not implement the function at all. Either way there is no code path
        that takes a cut of a transfer.
      </Callout>

      <h2>If a scanner says otherwise</h2>
      <p>
        Some terminals report Arcanium tokens as &ldquo;unsellable&rdquo; or as likely scams. That
        is a false positive with a specific cause: a honeypot detector buys and sells inside one
        simulated transaction, and when it cannot construct the <em>sell</em> route it reports
        &ldquo;unsellable&rdquo; rather than &ldquo;unsupported&rdquo;. Arc&apos;s Uniswap deployment
        sits at non-canonical addresses, so a router table keyed to the usual ones finds nothing
        here — and an unknown venue and a real honeypot produce the same verdict.
      </p>
      <p>
        The sell path works. It can be simulated against live chain state without spending anything,
        and our token-info API publishes the exact factory, router and fee tier a terminal needs in
        order to route.
      </p>

      <h2>What Arcanium does charge</h2>
      <p>
        A 1% fee on the pool itself, which is the ordinary Uniswap fee tier every launch uses and is
        paid out of the trade rather than skimmed from the token. Where it goes is covered under
        <em> Reward modes</em>.
      </p>
    </>
  ),
};
