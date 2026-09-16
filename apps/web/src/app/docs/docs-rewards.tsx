import type { ReactNode } from "react";
import { ARC_XCREATOR } from "@arch/chain-config";

/**
 * Creator reward documentation, including X payouts.
 *
 * The X page has one job beyond explaining the mechanics: it has to state the
 * trust boundary plainly. Verifying who controls an X account is not something
 * a blockchain can do, so this depends on OAuth and on a signer Arcanium runs.
 * Documentation that implied otherwise would be the dishonest kind, and anyone
 * deciding whether to route a fee stream through it deserves to know exactly
 * what they are relying on.
 */

function Mono({ children }: { readonly children: ReactNode }) {
  return <code className="docs-mono">{children}</code>;
}

function Callout({ children }: { readonly children: ReactNode }) {
  return <div className="docs-callout">{children}</div>;
}

export const REWARD_DOCS: Record<string, ReactNode> = {
  "rewards/modes": (
    <>
      <h1>Reward modes</h1>
      <p className="docs-lead">
        Every launch earns a share of its pool&apos;s 1% trading fee, forever. What happens to that
        share is fixed at launch and can never be changed.
      </p>

      <h2>The three modes</h2>
      <ul>
        <li>
          <strong>Standard</strong> — the creator&apos;s share is paid to the fee recipient in
          USDC.
        </li>
        <li>
          <strong>Divium</strong> — the creator&apos;s share is distributed to holders instead,
          proportionally, as the token accrues fees.
        </li>
        <li>
          <strong>Arcane</strong> — the creator&apos;s share buys the token on the open market and
          burns it.
        </li>
      </ul>
      <p>
        The protocol&apos;s share is unaffected by the mode. The token side of pool fees is always
        burned.
      </p>

      <h2>When payouts happen</h2>
      <p>
        Uniswap v3 fees sit uncollected until somebody calls for them, so none of these modes is
        self-executing. Arcanium runs a keeper that sweeps every launch on a timer, which is why
        dividends arrive and burns happen without anyone asking. The call is permissionless: it
        always pays the configured recipients and never the caller, so anyone can trigger it and
        nobody can redirect it.
      </p>
    </>
  ),

  "rewards/x": (
    <>
      <h1>Paying an X account</h1>
      <p className="docs-lead">
        A launch can send its creator fees to an X account instead of a wallet. The fees accumulate
        at a fixed address on Arc and wait there until whoever controls that account proves it and
        withdraws them.
      </p>

      <h2>Why this needs a mechanism at all</h2>
      <p>
        An X handle is not an address. Fees have to go somewhere the moment a token launches, which
        may be long before anyone knows which wallet the account&apos;s owner uses — or before its
        owner knows the token exists.
      </p>
      <p>
        So each X account gets a vault: a contract address derived from its identity, computable
        before the contract is deployed. A launch names that address as its fee recipient, USDC
        accrues there like it would in any wallet, and the vault itself is only deployed when
        somebody first claims.
      </p>

      <h2>The handle addresses the vault, the first claim owns it</h2>
      <p>
        A vault is derived from the handle, lowercased. That is what makes it nameable at launch:
        the address can be computed from a string somebody types, before the account&apos;s owner
        has ever visited this site or knows the token exists.
      </p>
      <p>
        Handles change hands, though, and a fee stream that followed the name would quietly follow
        it to a stranger. So the first X account to claim a vault is recorded against it, and every
        later claim must come from that same account. Rename yourself afterwards and the fees still
        reach you; someone who registers your old handle gets nothing.
      </p>
      <Callout>
        <p>
          <strong>The gap this leaves.</strong> If a handle is abandoned before its owner has ever
          claimed, whoever registers it next can claim first and keep it. Nothing on our side can
          tell those two people apart — that is the honest cost of not requiring X&apos;s paid API
          tier. If a launch has routed fees to your account, claim once, early. After that the
          handle is yours regardless of what happens to the name.
        </p>
      </Callout>

      <h2>Claiming</h2>
      <ol>
        <li>Connect the Arc wallet you want paid.</li>
        <li>Verify with X. This is a standard OAuth sign-in with PKCE.</li>
        <li>
          Arcanium&apos;s signer produces a short-lived, single-use authorisation naming your X
          identity, the vault, the asset, your wallet, a nonce and an expiry.
        </li>
        <li>You submit it. The vault checks the signature and pays out.</li>
      </ol>
      <p>
        You can claim repeatedly as fees accrue, and to a different wallet each time — verify
        again and name the new one. Changing wallets does not require anything to be migrated.
      </p>

      <h2>What you are trusting</h2>
      <Callout>
        <p>
          <strong>This is not trustless, and it cannot be.</strong> No blockchain can check who
          controls an X account. The vault verifies a signature from a signer Arcanium operates,
          and that signer decides which wallet a given X identity maps to. A dishonest or
          compromised signer could authorise a wallet it controls.
        </p>
      </Callout>
      <p>What the design does guarantee:</p>
      <ul>
        <li>
          The signer cannot move funds alone. A claim must be sent <em>by</em> the wallet named in
          the authorisation, so a leaked signature cannot be redirected to someone else.
        </li>
        <li>
          Every payout emits an event naming the identity and the recipient. Misuse would be
          visible on chain rather than silent.
        </li>
        <li>
          An authorisation is single-use, expires quickly, and is valid only for one vault on one
          chain. It cannot be replayed anywhere else.
        </li>
        <li>
          The signer is read from the factory at claim time, so a compromised key can be rotated
          without redeploying vaults or moving anyone&apos;s funds.
        </li>
        <li>
          A handle already claimed by one X account cannot be claimed by another, whatever happens
          to the name afterwards.
        </li>
        <li>
          Arcanium never holds the money. It sits in the vault contract until claimed.
        </li>
      </ul>

      <h2>Not the same as the token&apos;s X link</h2>
      <p>
        The X account under a token&apos;s social links is a label. This is the fee recipient. They
        are set separately and can be different accounts.
      </p>

      <h2>Contracts</h2>
      <ul>
        <li>
          Vault factory <Mono>{ARC_XCREATOR.factory}</Mono>
        </li>
        <li>
          Vault implementation <Mono>{ARC_XCREATOR.implementation}</Mono>
        </li>
        <li>
          Attestation signer <Mono>{ARC_XCREATOR.attestationSigner}</Mono>
        </li>
      </ul>
      <p>
        <Mono>vaultFor(keccak256(handle))</Mono> returns the address for any handle, deployed or
        not — lowercased, because X treats <Mono>@Alice</Mono> and <Mono>@alice</Mono> as one
        account and two vaults would split its fees.
      </p>
    </>
  ),
};
