import type { ReactNode } from "react";
import { ARC_TOKEN_LOCKER } from "@arch/chain-config";

/**
 * Integrator reference for locks: the endpoints, the events, and the rule that
 * the chain is always the authority.
 *
 * Written for someone building against this rather than using it, so it leads
 * with the failure modes — what a 503 means, why status is computed and not
 * stored, and which figures can be trusted when the indexer is behind.
 */

function Mono({ children }: { readonly children: ReactNode }) {
  return <code className="docs-mono">{children}</code>;
}

function Callout({ children }: { readonly children: ReactNode }) {
  return <div className="docs-callout">{children}</div>;
}

export const LOCKS_API_DOCS: Record<string, ReactNode> = {
  "reference/locks-api": (
    <>
      <h1>Lock API and events</h1>
      <p className="docs-lead">
        Locks are public. Every endpoint here is unauthenticated and CORS-open, because a lock is
        only worth making if a stranger can verify it.
      </p>

      <h2>Endpoints</h2>
      <table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Returns</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <Mono>GET /api/locks</Mono>
            </td>
            <td>A page of locks, newest first.</td>
          </tr>
          <tr>
            <td>
              <Mono>GET /api/locks?stats=1</Mono>
            </td>
            <td>Active locks, distinct tokens, claimable now, unlocking within 7 days.</td>
          </tr>
          <tr>
            <td>
              <Mono>GET /api/locks/:id</Mono>
            </td>
            <td>One lock by its on-chain id.</td>
          </tr>
        </tbody>
      </table>

      <h2>Filters</h2>
      <ul>
        <li>
          <Mono>token</Mono> — locks holding one ERC-20.
        </li>
        <li>
          <Mono>wallet</Mono> with <Mono>role=depositor|beneficiary|any</Mono>.
        </li>
        <li>
          <Mono>status=locked|claimable|claimed|all</Mono>.
        </li>
        <li>
          <Mono>limit</Mono> (max 200) and <Mono>offset</Mono>.
        </li>
      </ul>

      <h2>Status is computed, not stored</h2>
      <p>
        <Mono>locked</Mono>, <Mono>claimable</Mono> and <Mono>claimed</Mono> are derived at read
        time from the unlock timestamp and the clock. Nothing flips a stored column when a lock
        matures, so there is no window in which a matured lock still reports as locked. Treat{" "}
        <Mono>unlockTime</Mono> as the authority and compute your own status if you cache.
      </p>

      <h2>Amounts</h2>
      <p>
        <Mono>amount</Mono> is a decimal string in the token&apos;s base units, and{" "}
        <Mono>decimals</Mono> is supplied when known. Both are strings because a 256-bit integer
        does not survive JSON numbers. <Mono>symbol</Mono>, <Mono>name</Mono> and{" "}
        <Mono>decimals</Mono> are <Mono>null</Mono> for tokens Arcanium did not launch — the locker
        accepts any ERC-20 and we only know the metadata of our own.
      </p>

      <Callout>
        A <Mono>503</Mono> means we could not read the data, not that there are no locks. The two
        are different claims and this API will never substitute one for the other. Retry, or read
        the contract.
      </Callout>

      <h2>Reading the contract directly</h2>
      <p>
        Nothing here requires our API. The locker at <Mono>{ARC_TOKEN_LOCKER}</Mono> exposes{" "}
        <Mono>lockCount()</Mono>, <Mono>getLock(id)</Mono>, <Mono>isClaimable(id)</Mono>,{" "}
        <Mono>timeRemaining(id)</Mono> and <Mono>totalLocked(token)</Mono>. Ids start at 1. Our own
        pages fall back to these when the indexer is behind, and so should yours.
      </p>

      <h2>Events</h2>
      <p>Both carry indexed fields for the three questions worth asking.</p>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Indexed</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <Mono>LockCreated</Mono>
            </td>
            <td>
              <Mono>lockId</Mono>, <Mono>token</Mono>, <Mono>beneficiary</Mono>
            </td>
          </tr>
          <tr>
            <td>
              <Mono>LockClaimed</Mono>
            </td>
            <td>
              <Mono>lockId</Mono>, <Mono>token</Mono>, <Mono>beneficiary</Mono>
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        <Mono>LockCreated</Mono> also carries the depositor, the amount actually received, the
        unlock time and the creation time, unindexed.
      </p>
      <Callout>
        Arc&apos;s public RPCs prune logs after a few days. An integration that backfills from logs
        alone will silently lose older locks; enumerate with <Mono>lockCount()</Mono> and{" "}
        <Mono>getLock(id)</Mono> instead, which are direct calls and never expire.
      </Callout>
    </>
  ),
};
