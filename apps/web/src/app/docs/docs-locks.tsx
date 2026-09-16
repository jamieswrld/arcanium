import type { ReactNode } from "react";
import { ARC_TOKEN_LOCKER } from "@arch/chain-config";

/**
 * Token-lock documentation.
 *
 * Kept in its own module rather than appended to docs-content so the overview
 * file does not keep growing; both are merged into one record at the edge.
 *
 * The recurring job of this copy is to keep two different things apart. A
 * launch's liquidity is locked forever and belongs to nobody. A token lock has
 * an owner and an end date. Conflating them is the single most misleading thing
 * this feature could do, so the distinction is restated wherever somebody might
 * arrive without having read the page before it.
 */

function Mono({ children }: { readonly children: ReactNode }) {
  return <code className="docs-mono">{children}</code>;
}

function Callout({ children }: { readonly children: ReactNode }) {
  return <div className="docs-callout">{children}</div>;
}

export const LOCK_DOCS: Record<string, ReactNode> = {
  locks: (
    <>
      <h1>What a lock is</h1>
      <p className="docs-lead">
        A token lock puts an ERC-20 balance beyond reach until a date you choose. After that date
        one named wallet can withdraw it. Before that date nobody can — including you, and
        including Arcanium.
      </p>

      <h2>What it is for</h2>
      <p>
        Locks exist so a claim can be checked rather than believed. A team saying it will not sell
        for six months is a promise; the same tokens in a lock with a visible unlock date is a
        fact anyone can verify, without trusting the team or us.
      </p>
      <p>Common uses:</p>
      <ul>
        <li>A creator locking their own allocation to show they are not about to sell it.</li>
        <li>Vesting for a contributor, by locking to their wallet with a future date.</li>
        <li>Holding tokens for someone else until an agreed time.</li>
      </ul>

      <h2>This is not the same as launch liquidity</h2>
      <p>
        Every Arcanium launch puts its whole supply into a Uniswap position that is locked{" "}
        <strong>permanently</strong>. That liquidity has no owner, no unlock date and no withdrawal
        path — it is gone for good, by design, and it is what makes a launch tradable from its
        first block.
      </p>
      <p>
        Token locks are a separate tool and behave differently: they have a beneficiary, they have
        an end date, and on that date the beneficiary takes the tokens back. Seeing
        &ldquo;locked&rdquo; on a token page can mean either, so the interface labels them
        differently and so does this documentation.
      </p>

      <h2>What the contract can and cannot do</h2>
      <p>
        The locker has no owner. There is no pause, no rescue function, no admin unlock and no
        upgrade path. That is deliberate: a lock somebody can shorten is not a lock, and the entire
        value of the contract is that the promise it makes is the one it keeps.
      </p>
      <Callout>
        The same property has a cost. A lock created with the wrong recipient or the wrong date
        cannot be repaired by anyone. Check both before signing — there is no support channel that
        can undo it, because no such power exists.
      </Callout>

      <h2>Contract</h2>
      <p>
        <Mono>{ARC_TOKEN_LOCKER}</Mono> on Arc. It is not upgradeable, so this address is the code
        that will always run.
      </p>
    </>
  ),

  "locks/creating": (
    <>
      <h1>Creating a lock</h1>
      <p className="docs-lead">
        Locking takes two transactions: one to approve the amount, one to create the lock. The
        second is the one that moves the tokens.
      </p>

      <h2>What you choose</h2>
      <ul>
        <li>
          <strong>Token</strong> — any ERC-20 on Arc, not only tokens launched here. Paste the
          contract address and its name, symbol and your balance are read from the chain.
        </li>
        <li>
          <strong>Amount</strong> — in whole tokens. The contract records what it actually
          receives, which for a token that charges a fee on transfer is less than the amount sent.
        </li>
        <li>
          <strong>Recipient</strong> — the only address that will ever be able to withdraw. Defaults
          to your wallet. It cannot be changed afterwards.
        </li>
        <li>
          <strong>Unlock date</strong> — a preset or any future date and time you pick. The exact
          resolved moment is shown in both UTC and your local time before you sign, because
          &ldquo;1 year&rdquo; is the kind of phrase people agree to without checking what it means.
        </li>
      </ul>

      <h2>Approval</h2>
      <p>
        The first transaction approves exactly the amount being locked, not an unlimited allowance.
        A standing unlimited approval to a contract that will hold funds for years is a risk with
        no upside, so Arcanium does not ask for one.
      </p>
      <p>
        If the approval succeeds and the page still shows step one, reload — your approval is on
        chain and will be recognised.
      </p>

      <h2>Non-standard tokens</h2>
      <p>
        Fee-on-transfer tokens work: the amount credited is the balance the contract actually
        received, so the recorded figure matches what is there. Rebasing tokens are not supported
        in any meaningful sense — the contract stores a fixed amount, so a supply change after
        locking will not be reflected.
      </p>
    </>
  ),

  "locks/claiming": (
    <>
      <h1>Claiming</h1>
      <p className="docs-lead">
        At or after the unlock time, the beneficiary withdraws the tokens in one transaction.
        Before that time the contract rejects the attempt.
      </p>

      <h2>Who can claim</h2>
      <p>
        Only the beneficiary named when the lock was created. Not the depositor, even though they
        supplied the tokens, and not Arcanium. A lock can be claimed once; a second attempt
        reverts.
      </p>

      <h2>When</h2>
      <p>
        At the unlock second exactly, and any time after. There is no deadline and nothing expires
        — tokens left unclaimed stay in the contract until the beneficiary comes for them.
      </p>

      <h2>If the interface is unavailable</h2>
      <p>
        The locker is an ordinary contract and does not depend on this website. Calling{" "}
        <Mono>claim(lockId)</Mono> on <Mono>{ARC_TOKEN_LOCKER}</Mono> from any tool that can reach
        Arc does the same thing. Lock pages here read the contract directly, so they also work when
        our indexer is behind.
      </p>

      <Callout>
        Nobody can claim early and nobody can extend a lock. If a date was set wrongly, the only
        options are to wait for it or to abandon the tokens.
      </Callout>
    </>
  ),
};
