import type { ReactNode } from "react";

/** Deployed mainnet contract addresses (Arc chain 5042). */
/**
 * Deployed mainnet addresses (Arc chain 5042), read back from chain.
 *
 * These had drifted: the factory named here was the v3 generation and the
 * distributor an older one still, long after launches moved to v4. Published
 * documentation is the worst place for a stale address — anyone integrating
 * against it would wire themselves to a superseded contract.
 */
const A = {
  factory: "0x8e5732b520a318251a702a680aa7f123fb92af52",
  liquidityVault: "0x94e8335bed5585f3f43899505b5e5968fa11185e",
  distributor: "0x7c148b6a581e32ccb6fff7bd59af4250d5ec1ebc",
  graduation: "0xc73d4b6bd63f0ee69514768870d74548f4d12bc6",
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
        Arcanium is a launchpad on Arc. Any token you create trades from its very first block on real
        Uniswap liquidity that is permanently locked — paired with native Arc USDC.
      </p>
      <p>
        A launch mints a fixed billion-token supply straight into a Uniswap v3 pool. There is no bonding
        curve, no waiting room, and no team allocation: the full supply is the liquidity, and that liquidity
        can never be pulled. You pay with the USDC already in your wallet on Arc.
      </p>
      <p>Two things to know up front:</p>
      <ul>
        <li>Everything happens on <strong>Arc</strong> (chain 5042), where gas is paid in USDC itself.</li>
        <li>Tokens pair with <strong>native USDC</strong> — so buying, selling, and creator rewards are all denominated in real dollars.</li>
      </ul>
      <Callout>
        New here? Start with <a href="/docs/start/connect">Connect a wallet</a>, then launch from the{" "}
        <a href="/create">Create</a> page.
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
      <h2>3. Get on Arc</h2>
      <p>Arcanium runs on the <strong>Arc</strong> network. If the header shows &quot;Wrong network&quot;, click it — your wallet will switch, adding Arc automatically if it&apos;s new. Full network details on the next page.</p>
    </>
  ),

  "start/networks": (
    <>
      <h1>Add the Arc network</h1>
      <p className="docs-lead">Arc is a stablecoin-native chain where gas is paid in USDC itself. The site can add it for you in one click.</p>
      <h2>The easy way</h2>
      <p>Connect your wallet, then click the <strong>Wrong network</strong> pill (or the switch button on the Portfolio page). Your wallet prompts you to switch and, if Arc is new to it, to add it. Approve, and you&apos;re set.</p>
      <h2>Manual settings</h2>
      <ul>
        <li>Network name: <strong>Arc</strong></li>
        <li>RPC URL: <Mono>https://rpc.blockdaemon.mainnet.arc.io</Mono></li>
        <li>Chain ID: <Mono>5042</Mono></li>
        <li>Currency symbol: <Mono>USDC</Mono></li>
        <li>Block explorer: <Mono>https://arc-scan.org</Mono></li>
      </ul>
      <Callout>On Arc, USDC <em>is</em> the gas token — the same balance pays for gas and for launching or trading. Keep a little on hand.</Callout>
    </>
  ),

  "start/get-usdc": (
    <>
      <h1>Getting USDC on Arc</h1>
      <p className="docs-lead">Everything on Arcanium is denominated in USDC held on the Arc network. That one balance covers gas, optional first buys, and trades.</p>
      <h2>You start with USDC on Base or Ethereum</h2>
      <p>To get USDC onto Arc you first need <strong>USDC on Base or Ethereum</strong>, then bridge it across. If you don&apos;t have any yet, buy USDC on an exchange (Coinbase, Kraken, and others) and withdraw it on the <strong>Base</strong> or <strong>Ethereum</strong> network.</p>
      <h2>Bridge it to Arc with Circle CCTP</h2>
      <p>Use Circle&apos;s Cross-Chain Transfer Protocol (CCTP) — the official USDC bridge — to move your USDC from Base or Ethereum to Arc. CCTP burns the USDC on the source chain and mints native USDC to you on Arc, one for one. Make sure the destination is the <strong>Arc</strong> network (chain 5042).</p>
      <h2>How much you need</h2>
      <ul>
        <li>Enough USDC for an optional first buy — launching itself is free (gas only).</li>
        <li>A little extra for gas — on Arc, gas is paid in that same USDC.</li>
      </ul>
      <Callout>Once your USDC lands on Arc, head to <a href="/create">Create</a> to launch, or <a href="/tokens">Launchpad</a> to trade.</Callout>
    </>
  ),

  launchpad: (
    <>
      <h1>Launching a token</h1>
      <p className="docs-lead">Set a name, ticker, image, and optional description and socials, add an optional first buy, and confirm. Everything else happens in one transaction.</p>
      <p>Arcanium mints a fixed supply of one billion tokens and places all of it into a Uniswap v3 pool paired with native Arc USDC, so the token trades on Uniswap immediately. There is no bonding curve, no separate pre-graduation market, and no proxy.</p>
      <h2>What you get in one transaction</h2>
      <ul>
        <li>A fixed-supply token — one billion, 18 decimals, no further minting, no owner.</li>
        <li>A Uniswap v3 pool paired with native USDC at the 1% fee tier, initialised near a $3,000 starting market cap.</li>
        <li>The entire supply as a single-sided position, locked permanently in the liquidity vault.</li>
        <li>Optionally, your own first purchase — executed atomically, so no one can trade ahead of you.</li>
      </ul>
      <p>Launching is free — you only pay Arc network gas (a few cents of USDC). As the creator, you earn a share of the pool&apos;s trading fees for the life of the token.</p>
    </>
  ),

  "launchpad/economics": (
    <>
      <h1>Pricing and graduation</h1>
      <h2>Starting price and graduation</h2>
      <p>Every token launches at roughly a $3,000 starting market cap. As people buy, the price rises along the single-sided position; as they sell, it falls. A token <strong>graduates</strong> when its pool balance first reaches 9,000 USDC. Graduation is a permanent label the app applies at that point — it does not unlock liquidity, change the token, or create a new market.</p>
      <h2>Trading fees</h2>
      <p>Every token trades on the standard Uniswap v3 1% fee tier. Fees are handled by side:</p>
      <table className="docs-table">
        <thead><tr><th>Fee side</th><th>Where it goes</th></tr></thead>
        <tbody>
          <tr><td>Token side</td><td>Burned, reducing supply</td></tr>
          <tr><td>USDC side</td><td>A share to the creator, the remainder funds the protocol</td></tr>
        </tbody>
      </table>
      <p>Recipients are fixed for the life of the pool, so creator rewards keep accruing in USDC. Anyone can trigger a fee distribution.</p>
      <h2>Locked liquidity</h2>
      <p>The launch position is held in the Arcanium liquidity vault and can never be withdrawn — the liquidity cannot be pulled out from under the pool. As with any market, the token&apos;s price can still fall.</p>
    </>
  ),

  "launchpad/trading": (
    <>
      <h1>Buying and selling</h1>
      <p className="docs-lead">Every launched token trades on a standard Uniswap v3 pool paired with native USDC. Arcanium adds no extra router fee.</p>
      <h2>To trade</h2>
      <ol>
        <li>Open a token from the <a href="/tokens">Launchpad</a>.</li>
        <li>Use the Buy/Sell panel: pick an amount (or a percentage of your balance), set your slippage, and confirm.</li>
        <li>Your swap routes directly through the Uniswap v3 router at the 1% fee tier, paying in USDC.</li>
      </ol>
      <Callout>Trading happens on Arc, which charges gas in native USDC — the same balance you trade with. Keep a little spare for gas.</Callout>
      <p>Prices, market cap, and activity on each token page are read live from the pool. There is no internal order book — what you see is the real on-chain market.</p>
    </>
  ),

  "reference/addresses": (
    <>
      <h1>Contract addresses</h1>
      <p className="docs-lead">Arcanium runs on Arc (chain 5042). Verify every interaction against these addresses.</p>
      <h2>Arc (5042)</h2>
      <table className="docs-table">
        <tbody>
          <tr><td>Launchpad factory</td><td><Mono>{A.factory}</Mono></td></tr>
          <tr><td>Liquidity vault</td><td><Mono>{A.liquidityVault}</Mono></td></tr>
          <tr><td>Fee distributor</td><td><Mono>{A.distributor}</Mono></td></tr>
          <tr><td>Graduation registry</td><td><Mono>{A.graduation}</Mono></td></tr>
          <tr><td>USDC (native)</td><td><Mono>{A.arcUsdc}</Mono></td></tr>
        </tbody>
      </table>
    </>
  ),

  "reference/integrators": (
    <>
      <h1>Terminals &amp; integrators</h1>
      <p className="docs-lead">Everything a trading terminal, screener, or bot needs to list Arcanium launches with names, logos, socials, and market data.</p>
      <h2>Token info API</h2>
      <p>CORS-open, edge-cached, no key required:</p>
      <ul>
        <li><Mono>GET https://arcanium.trade/api/token-info</Mono> — index of every launch (address, symbol, pool, creator).</li>
        <li><Mono>GET https://arcanium.trade/api/token-info/&#123;address&#125;</Mono> — full detail: name, symbol, <strong>logo image</strong>, description, website / X / Telegram links, live price, market cap, liquidity, pool address, and provenance.</li>
      </ul>
      <h2>On-chain discovery</h2>
      <p>Launches emit <Mono>Launched(token, creator, pairToken, pool, positionId, metadataUri)</Mono> on the factory. The <Mono>metadataUri</Mono> is a self-contained data URI holding the same JSON (image and socials included), so metadata is recoverable from chain data alone.</p>
      <table className="docs-table">
        <tbody>
          <tr><td>Factory (current)</td><td><Mono>{A.factory}</Mono></td></tr>
          <tr><td>Quote token</td><td><Mono>{A.arcUsdc}</Mono> (native USDC, 6d ERC-20 view)</td></tr>
          <tr><td>Pools</td><td>Standard Uniswap v3, 1% tier, liquidity permanently locked</td></tr>
        </tbody>
      </table>
      <Callout>Building an integration or want Arcanium listed as a launchpad filter on your terminal? Reach out on X: <a href="https://x.com/arcaniumtrade" target="_blank" rel="noreferrer">@arcaniumtrade</a>.</Callout>
    </>
  ),

  "reference/security": (
    <>
      <h1>Security and risks</h1>
      <p className="docs-lead">Read this before using Arcanium with real funds.</p>
      <ul>
        <li>Every token is paired with native USDC on a standard Uniswap v3 pool. Arcanium adds no router tax.</li>
        <li>Launch liquidity is permanently locked, but token prices can still fall to zero.</li>
        <li>The full supply is the liquidity — there is no team allocation and no further minting.</li>
        <li>Graduation is a permanent display label only; it does not unlock liquidity or change the token.</li>
        <li>Launching is free (network gas only). Trading fees on each pool are split between the token creator and the protocol; token-side fees are burned.</li>
        <li>Arc is an early network. Availability of USDC on-ramps and infrastructure is still maturing.</li>
        <li>Smart-contract and operator risks exist. Use funds you can afford to lose.</li>
      </ul>
      <Callout>Arcanium is an independent project. It is not endorsed by or affiliated with Circle, Arc, or Uniswap.</Callout>
    </>
  ),
};
