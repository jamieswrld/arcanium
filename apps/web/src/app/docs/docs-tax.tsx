import type { ReactNode } from "react";

/**
 * The trade tax.
 *
 * This page has been rewritten twice, which is worth knowing when reading it.
 * It first described a tax creators could set on v3. That was withdrawn once it
 * turned out a v3 token carrying one cannot be sold at all. It is back because
 * v4 takes the fee somewhere else entirely — and the difference between those
 * two situations is the single most important thing on the page, so it is
 * explained rather than asserted.
 */

function Mono({ children }: { readonly children: ReactNode }) {
  return <code className="docs-mono">{children}</code>;
}

function Callout({ children }: { readonly children: ReactNode }) {
  return <div className="docs-callout">{children}</div>;
}

export const TAX_DOCS: Record<string, ReactNode> = {
  "launchpad/tax": (
    <>
      <h1>Trade tax</h1>
      <p className="docs-lead">
        A launch can charge up to 9% on every trade, on top of the 1% base fee. It is optional,
        fixed at launch, and can never be changed afterwards. Most tokens set it to zero.
      </p>

      <h2>Where it goes</h2>
      <p>
        Wherever your reward mode sends fees. The token side of a trade is always burned, and the
        USDC side is split between you and the protocol — a tax simply makes both larger. Under{" "}
        <em>Divium</em> that means bigger payouts to holders; under <em>Arcane</em>, more buying and
        burning. It is a dial on the mechanism you already chose, not a separate revenue stream.
      </p>

      <h2>Why this is safe here and was not before</h2>
      <p>
        Taxed tokens have a bad reputation for a specific and correct reason. The usual
        implementation skims the token&apos;s own transfer. On Uniswap v3 a sell delivers its input
        to the pool <em>as a transfer</em>, and the pool then checks it received the amount it was
        promised — so a tax makes the pool come up short and every sell reverts. The buy still
        works. That is a honeypot, and it is why Arcanium refused to offer a tax on its v3 launches.
      </p>
      <p>
        A v4 launch takes its fee in the hook, during the swap, through <Mono>afterSwap</Mono>. The
        pool always receives exactly what it was promised, so nothing breaks. The token&apos;s own
        transfers are completely untaxed — sending it to a friend, an exchange or a cold wallet
        costs nothing.
      </p>
      <Callout>
        This is not a claim to take on trust. The test suite sells a token carrying a 5% tax on v4
        and asserts the USDC arrives, and a second test pins the v3 failure so the two can never be
        confused again. Read <Mono>taxBps()</Mono> on any older Arcanium token and it returns zero.
      </Callout>

      <h2>What a trader pays</h2>
      <p>
        The tax plus the 1% base. A 5% tax means about 6% per trade. The 9% ceiling exists so the
        total can never exceed 10%, and it is enforced by the contract rather than the interface.
      </p>
      <p>
        Quotes from outside tools do not include it, because it is charged inside the swap. Token
        pages here show the rate above the trade panel whenever it is not zero, so nobody meets it
        for the first time in their wallet balance.
      </p>

      <h2>Choosing a rate</h2>
      <p>
        Zero is the default and is right for most tokens: a tax makes yours more expensive to trade
        than its neighbours, and some aggregators rank or route taxed tokens worse. It earns its
        place when continuous burning or continuous holder payouts are the actual point of the
        token rather than a detail — in which case the tax is the engine, and a visible rate is
        part of the pitch.
      </p>
    </>
  ),
};
