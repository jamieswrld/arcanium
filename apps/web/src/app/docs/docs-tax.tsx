import type { ReactNode } from "react";

/**
 * The trade tax.
 *
 * This page exists because the tax is the one thing a creator can set that
 * costs other people money. The mechanics are simple; what needs saying
 * plainly is that quotes do not include it, that it is burned rather than
 * earned, and that it can never be changed afterwards. A creator who reads
 * only the launch form should still not be able to misunderstand any of those.
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
        A creator can set a tax of up to 9% on every trade of their token. It is taken on both buys
        and sells, and all of it is burned. Most launches set it to zero.
      </p>

      <h2>It is burned, not earned</h2>
      <p>
        The tax does not pay the creator and does not pay Arcanium. Every unit collected goes to the
        burn address and permanently leaves the supply. If you are setting one, you are choosing
        deflation, not income — creator income is the reward share, which is a separate thing
        covered under <Mono>Reward modes</Mono>.
      </p>

      <h2>What a trader actually pays</h2>
      <p>
        The tax sits on top of the 1% pool fee, so a 5% tax means about 6% per trade in total. The
        hard ceiling of 9% exists so the total can never exceed 10%.
      </p>
      <Callout>
        Quotes do not include it. The tax is charged inside the token&apos;s own transfer, which
        means the pool, the router and every outside aggregator all report the pre-tax figure and
        your wallet then receives less than you were shown. This is not specific to Arcanium — it is
        true of every taxed token everywhere — but it is the thing that surprises people, so
        Arcanium displays the rate above the trade panel on any token that charges one.
      </Callout>

      <h2>Only trades are taxed</h2>
      <p>
        Sending the token from one wallet to another is untouched, as are airdrops and exchange
        deposits. Only trades against the launch pool are taxed.
      </p>

      <h2>It is fixed forever</h2>
      <p>
        The rate is set at launch and there is no function to change it afterwards — not for the
        creator, not for Arcanium. A rate that could be raised after people had bought would not be
        a term, it would be a promise, and this is deliberately the former.
      </p>

      <h2>Choosing a rate</h2>
      <p>
        Zero is the default and is what nearly every token should use. A tax makes a token more
        expensive to trade than its competitors and shows as a warning on its page, so it is worth
        setting only when continuous supply reduction is genuinely the point of the token rather
        than a detail. Aggregators and terminals generally rank taxed tokens worse, and some
        refuse to route them at all.
      </p>
    </>
  ),
};
