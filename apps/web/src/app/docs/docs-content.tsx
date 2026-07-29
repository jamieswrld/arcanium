import type { ReactNode } from "react";

/** Deployed mainnet contract addresses (chain 5042 + Base mainnet). */
const A = {
  vault: "0x5d07afa33788f7ba2f9ddc7379efdde218ba2258",
  ausd: "0xe6051e65e59411d6294bb978b1095af59201f83e",
  bridge: "0x9c974f3c8601ff594a93232c91960aec347b1303",
  gasStation: "0x5d07afa33788f7ba2f9ddc7379efdde218ba2258",
  factory: "0x1d65ab4cdcdda6f38a9c93a24ef64be8905e19d5",
  liquidityVault: "0x94e8335bed5585f3f43899505b5e5968fa11185e",
  distributor: "0xbdc362f9ddea2ae9c39b108e0712f7d6e2f00e5f",
  graduation: "0x40437f7d81dde22126849a7baef71e0280d17f68",
  baseUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  arcUsdc: "0x3600000000000000000000000000000000000000",
} as const;

function Mono({ children }: { readonly children: ReactNode }) {
  return <code className="docs-mono">{children}</code>;
}

function Callout({ children }: { readonly children: ReactNode }) {
  return <div className="docs-callout">{children}</div>;
}

/** Content keyed by slug. "" is the overview. */
export const DOCS: Record<string, ReactNode> = {
  "": (
    <>
      <h1>Arcanium</h1>
      <p className="docs-lead">
        Arcanium is two things that work together: a bridge that turns Base USDC into a spendable dollar on
        Arc, and a launchpad where any token trades from its first block through permanently locked liquidity.
      </p>
      <p>
        Bridging locks your USDC on Base and issues <strong>aUSD</strong> on Arc against it. Redeeming does the
        reverse, one for one. On the launchpad, a creation mints a fixed billion-token supply straight into a
        Uniswap v3 pool — no bonding curve, no waiting room, no team allocation.
      </p>
      <p>Two things to know up front:</p>
      <ul>
        <li>The bridge is asynchronous. Your transaction records the request; the funds land on the other side about a minute later.</li>
        <li>Arc charges gas in native USDC, not aUSD. If you only hold aUSD, the gas station sells you a little for your first transaction.</li>
      </ul>
      <Callout>
        New here? Start with <a href="/docs/start/connect">Connect a wallet</a>, then bridge from the{" "}
        <a href="/">Bridge</a> page.
      </Callout>
    </>
  ),

  "start/connect": (
    <>
      <h1>Connect a wallet</h1>
      <p className="docs-lead">Arcanium is a website you use with a self-custodial wallet. We never hold your funds or see your keys.</p>
      <h2>1. Install a wallet</h2>
      <p>Any EVM browser wallet works: MetaMask, Rabby, Coinbase Wallet, or Rainbow. Install one as a browser extension and create or import an account.</p>
      <h2>2. Connect</h2>
      <p>Click <strong>Connect wallet</strong> in the top right. Arcanium detects every wallet you have installed and lets you pick. Approve the connection in your wallet — this only shares your public address.</p>
      <h2>3. Get on the right network</h2>
      <p>Arcanium uses two networks: <strong>Base</strong> for bridging in and out, and <strong>Arc</strong> for trading and launching. If the header shows &quot;Wrong network&quot;, click it — your wallet will switch, adding the network automatically if it&apos;s new. Full details on the next page.</p>
    </>
  ),

  "start/networks": (
    <>
      <h1>Add Base and Arc</h1>
      <p className="docs-lead">You bridge on Base and trade on Arc, so your wallet needs both networks. The site can add them for you in one click.</p>
      <h2>The easy way</h2>
      <p>Connect your wallet, then click the <strong>Wrong network</strong> pill (or the switch button on the Portfolio page). Your wallet prompts you to switch and, if the network is new to it, to add it. Approve, and you&apos;re set.</p>
      <h2>Base</h2>
      <p>Base is an Ethereum layer-2 by Coinbase. Most wallets already include it. If not, add it manually:</p>
      <ul>
        <li>Network name: <strong>Base</strong></li>
        <li>RPC URL: <Mono>https://mainnet.base.org</Mono></li>
        <li>Chain ID: <Mono>8453</Mono></li>
        <li>Currency symbol: <Mono>ETH</Mono></li>
        <li>Block explorer: <Mono>https://basescan.org</Mono></li>
      </ul>
      <Callout>Base pays gas in ETH. Keep a few dollars of ETH on Base to cover bridge transactions.</Callout>
      <h2>Arc</h2>
      <p>Arc is a stablecoin-native chain where gas is paid in USDC itself.</p>
      <ul>
        <li>Network name: <strong>Arc</strong></li>
        <li>RPC URL: <Mono>https://5042.rpc.thirdweb.com</Mono></li>
        <li>Chain ID: <Mono>5042</Mono></li>
        <li>Currency symbol: <Mono>USDC</Mono></li>
      </ul>
    </>
  ),

  "start/get-usdc": (
    <>
      <h1>Getting USDC on Base</h1>
      <p className="docs-lead">Everything starts with USDC on the Base network. Here is how to get some there.</p>
      <h2>From an exchange</h2>
      <p>Buy USDC on an exchange (Coinbase, Kraken, and others), then withdraw it — and this is the important part — <strong>on the Base network</strong>. When you choose the withdrawal network, pick <strong>Base</strong>, not Ethereum. Withdrawing on the wrong network sends it somewhere Arcanium can&apos;t use.</p>
      <h2>From another chain</h2>
      <p>If you already hold USDC on Ethereum or another chain, bridge it to Base using Circle&apos;s CCTP (the official USDC bridge) or Base&apos;s bridge at bridge.base.org.</p>
      <h2>Don&apos;t forget gas</h2>
      <p>You also need a small amount of <strong>ETH on Base</strong> to pay for the deposit transaction — a few dollars is plenty. Most exchanges let you withdraw ETH on Base the same way.</p>
      <Callout>Once you have USDC (and a little ETH) on Base, head to the <a href="/">Bridge</a> page to get aUSD on Arc.</Callout>
    </>
  ),

  bridge: (
    <>
      <h1>How the bridge works</h1>
      <p className="docs-lead">USDC on Base becomes aUSD on Arc, backed one for one.</p>
      <p>Arcanium runs a vault on Base that holds the USDC reserve, and issues aUSD on Arc against it. The exact amount you receive is shown before you sign, so there are no surprises.</p>
      <h2>Bridging in (Base → Arc)</h2>
      <ol>
        <li>On the Bridge page, enter an amount of USDC and confirm the review.</li>
        <li>Your USDC is pulled into the Arcanium vault on Base and held as reserve.</li>
        <li>About a minute later, aUSD is minted to your address on Arc.</li>
      </ol>
      <p>You can send the aUSD to any address you like — the recipient does not have to be the sender.</p>
      <h2>Redeeming out (Arc → Base)</h2>
      <p>Redeeming burns your aUSD on Arc first. Only once that burn is confirmed does the vault release USDC to you on Base, one for one. See <a href="/docs/bridge/sell">Selling aUSD back to USDC</a> for a step-by-step.</p>
      <Callout>Completion means the destination chain confirmed it — not the source receipt. The Bridge page tracks this for you.</Callout>
    </>
  ),

  "bridge/fees": (
    <>
      <h1>Fees, finality and safety</h1>
      <h2>Fees</h2>
      <table className="docs-table">
        <thead><tr><th>Action</th><th>Fee</th></tr></thead>
        <tbody>
          <tr><td>Bridge in (Base → Arc)</td><td>10%, taken at deposit</td></tr>
          <tr><td>Redeem (Arc → Base)</td><td>Free, one for one</td></tr>
        </tbody>
      </table>
      <p>The deposit fee and the current limits are read live from the contract on the Bridge screen, so always trust what the screen shows over any number written here.</p>
      <h2>Finality</h2>
      <p>The bridge waits for your deposit or burn to be several blocks deep before acting, so a chain reorganisation cannot lose or duplicate a transfer. In normal conditions a transfer settles in about a minute.</p>
      <h2>Safety</h2>
      <ul>
        <li>The contracts hold the invariant that the USDC reserve on Base always covers the aUSD supply on Arc. You can verify it yourself at any time via the live status on the Bridge page.</li>
        <li>Each mint and release is tied to a unique, deterministic id, so a single deposit can mint at most once and a single burn can release at most once.</li>
        <li>The reserve can only move through releases or a publicly visible migration; it cannot be swept.</li>
      </ul>
    </>
  ),

  "bridge/sell": (
    <>
      <h1>Selling aUSD back to USDC</h1>
      <p className="docs-lead">aUSD is always redeemable for USDC, one for one, with no fee. Here is exactly how to get your dollars back on Base.</p>
      <h2>What you need</h2>
      <ul>
        <li>aUSD in your wallet on Arc.</li>
        <li>A little native USDC gas on Arc to pay for the burn. If you have none, use the <a href="/gas">Gas</a> page first — you sign a gasless permit and a relayer covers it.</li>
      </ul>
      <h2>Steps</h2>
      <ol>
        <li>Go to the <a href="/">Bridge</a> page and press the switch (⇅) so it reads <strong>Arc → Base</strong>.</li>
        <li>Enter the amount of aUSD you want to sell. The review shows you receive the same amount of USDC, with no fee.</li>
        <li>Confirm. This burns your aUSD on Arc.</li>
        <li>Wait about a minute. USDC is released to your address on Base, one for one.</li>
      </ol>
      <Callout>The USDC arrives on <strong>Base</strong>. To move it to an exchange, withdraw/deposit it on the Base network. From there you can cash out to your bank as normal.</Callout>
      <h2>Good to know</h2>
      <ul>
        <li>Redemption is always free — you get back exactly what you burn.</li>
        <li>If your wallet shows the aUSD gone but the USDC not yet arrived, it is in flight; the destination confirmation is what completes it.</li>
        <li>You can redeem any amount, any time. There is no lockup.</li>
      </ul>
    </>
  ),

  "bridge/wind-down": (
    <>
      <h1>Switching to native USDC</h1>
      <p className="docs-lead">aUSD is a bridged dollar for today. When native USDC is fully available on Arc, aUSD converts to it one for one.</p>
      <p>When that happens: new deposits close first, the USDC backing the supply moves across, and a permanent one-for-one exchange opens. Holders can convert aUSD to native USDC at any time, with no deadline.</p>
      <p>The exchange cannot open underwater — it only opens once the USDC on hand fully covers every outstanding aUSD, so the last holder to convert is covered as fully as the first. Tokens that launched paired with aUSD convert to USDC-paired pools at the same price, and creator rewards continue in USDC.</p>
      <Callout>Until then, aUSD is issued by Arcanium — not Circle — and is backed by USDC held in the Arcanium vault on Base.</Callout>
    </>
  ),

  launchpad: (
    <>
      <h1>Launching a token</h1>
      <p className="docs-lead">Set a name, ticker, image, and optional description and socials, choose your pair asset, and pay the launch fee. Everything else happens in one transaction.</p>
      <p>Arcanium mints a fixed supply of one billion tokens and places all of it into a Uniswap v3 pool, so the token trades on Uniswap immediately. There is no bonding curve, no separate pre-graduation market, and no proxy.</p>
      <h2>What you get in one transaction</h2>
      <ul>
        <li>A fixed-supply token — one billion, 18 decimals, no further minting, no owner, no taxes.</li>
        <li>A Uniswap v3 pool at the 1% fee tier, initialised near a $3,000 starting market cap.</li>
        <li>The entire supply as a single-sided position, locked permanently in the liquidity vault.</li>
        <li>Optionally, your own first purchase — executed atomically, so no one can trade ahead of you.</li>
      </ul>
      <p>The launch fee is charged in the pair asset and read live from the contract on the Create page.</p>
    </>
  ),

  "launchpad/economics": (
    <>
      <h1>Pricing, graduation and fees</h1>
      <h2>Starting price and graduation</h2>
      <p>Every token launches at roughly a $3,000 starting market cap. As people buy, the price rises along the single-sided position; as they sell, it falls. A token <strong>graduates</strong> when its pool balance first reaches 9,000 in the pair asset. Graduation is a permanent label the app applies at that point — it does not unlock liquidity, change the token, create a new market, or alter fees.</p>
      <h2>Trading fees and creator rewards</h2>
      <p>Trading uses the standard Uniswap v3 1% fee tier. Fees split by side:</p>
      <table className="docs-table">
        <thead><tr><th>Fee side</th><th>Where it goes</th></tr></thead>
        <tbody>
          <tr><td>Token side</td><td>100% burned, reducing supply</td></tr>
          <tr><td>Pair side</td><td>10% to the token creator, 90% to Arcanium</td></tr>
        </tbody>
      </table>
      <p>Recipients are fixed for the life of the pool, so creator rewards keep accruing. Anyone can trigger a fee distribution.</p>
      <h2>Locked liquidity</h2>
      <p>The launch position is held in the Arcanium liquidity vault and can never be withdrawn — the liquidity cannot be pulled out from under the pool. As with any market, the token&apos;s price can still fall.</p>
    </>
  ),

  "launchpad/trading": (
    <>
      <h1>Buying and selling</h1>
      <p className="docs-lead">Every launched token trades on a standard Uniswap v3 pool. Arcanium adds no extra router fee.</p>
      <h2>To trade</h2>
      <ol>
        <li>Open a token from the <a href="/tokens">Launchpad</a>.</li>
        <li>Use the Buy/Sell panel: pick an amount (or a percentage of your balance), set your slippage, and confirm.</li>
        <li>Your swap routes directly through the Uniswap v3 router at the 1% fee tier.</li>
      </ol>
      <Callout>Trading happens on Arc, which charges gas in native USDC. If you only hold aUSD, top up on the <a href="/gas">Gas</a> page first.</Callout>
      <p>Prices, market cap, and holders on each token page are read live from the pool. There is no internal order book — what you see is the real on-chain market.</p>
    </>
  ),

  gas: (
    <>
      <h1>Sponsored Arc gas</h1>
      <p className="docs-lead">Arc charges gas in native USDC. If your wallet only holds bridged aUSD, the gas station sells you a small amount so you can transact.</p>
      <h2>How it works</h2>
      <ol>
        <li>On the Gas page, pick what you need gas for and get a quote. It states how much native USDC you receive and how much aUSD you pay, including a visible 5% service margin.</li>
        <li>You sign an EIP-2612 permit for exactly that aUSD amount. Signing costs no gas.</li>
        <li>An Arcanium relayer submits the transaction and delivers native USDC to your wallet.</li>
      </ol>
      <Callout>The gas station is a convenience for small amounts. If you can bridge USDC in directly, that is cheaper.</Callout>
    </>
  ),

  "reference/addresses": (
    <>
      <h1>Contract addresses</h1>
      <p className="docs-lead">Arcanium runs on Base (chain 8453) and Arc (chain 5042). Verify every interaction against these addresses.</p>
      <h2>Base (8453)</h2>
      <table className="docs-table">
        <tbody>
          <tr><td>Vault (USDC reserve)</td><td><Mono>{A.vault}</Mono></td></tr>
          <tr><td>USDC (Circle)</td><td><Mono>{A.baseUsdc}</Mono></td></tr>
        </tbody>
      </table>
      <h2>Arc (5042)</h2>
      <table className="docs-table">
        <tbody>
          <tr><td>aUSD</td><td><Mono>{A.ausd}</Mono></td></tr>
          <tr><td>Bridge</td><td><Mono>{A.bridge}</Mono></td></tr>
          <tr><td>Gas station</td><td><Mono>{A.gasStation}</Mono></td></tr>
          <tr><td>Launchpad factory</td><td><Mono>{A.factory}</Mono></td></tr>
          <tr><td>Liquidity vault</td><td><Mono>{A.liquidityVault}</Mono></td></tr>
          <tr><td>Fee distributor</td><td><Mono>{A.distributor}</Mono></td></tr>
          <tr><td>Graduation registry</td><td><Mono>{A.graduation}</Mono></td></tr>
          <tr><td>USDC (native)</td><td><Mono>{A.arcUsdc}</Mono></td></tr>
        </tbody>
      </table>
    </>
  ),

  "reference/security": (
    <>
      <h1>Security and risks</h1>
      <p className="docs-lead">Read this before using Arcanium with real funds.</p>
      <ul>
        <li>aUSD is issued by Arcanium, not Circle, and is not native USDC.</li>
        <li>aUSD is backed one for one by USDC held in the Arcanium vault on Base, after the bridge fee.</li>
        <li>Bridging in charges a fee; redemption is free and one for one.</li>
        <li>The bridge is asynchronous — completion means the destination chain confirmed it.</li>
        <li>Launch liquidity is permanently locked, but token prices can still fall to zero.</li>
        <li>Graduation is a permanent display label only.</li>
        <li>All trading happens on standard Uniswap v3 pools; Arcanium adds no router tax.</li>
        <li>Quote-side LP fees split 10% to creators and 90% to Arcanium; token-side LP fees are burned.</li>
        <li>Smart-contract and operator risks exist. Use funds you can afford to lose.</li>
      </ul>
      <Callout>Arcanium is an independent project. It is not endorsed by or affiliated with Circle, Arc, Base, or Uniswap.</Callout>
    </>
  ),
};
