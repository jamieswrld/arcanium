import type { NextResponse } from "next/server";
import { encodeFunctionData, type Hex } from "viem";
import { arcPublicClient, factoryAbi, fetchToken, routerAbi } from "@/lib/launchpad";
import { indexedToken } from "@/lib/indexed";
import { erc20Abi } from "@/lib/bridgeClient";
import { getChain } from "@/lib/chains";
import { fail, handle, ok, parseAddress, preflight } from "@/lib/apiV1";

/**
 * POST /api/v1/transactions/{buy|sell|launch}
 *
 * Builds an unsigned transaction for the caller's wallet to sign.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS ENDPOINT NEVER TAKES A PRIVATE KEY, NEVER SIGNS, AND NEVER BROADCASTS.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It returns `{ to, data, value, chainId }` — ordinary calldata you can hand to
 * viem, ethers, or a wallet's `eth_sendTransaction`. Nothing here has custody of
 * anything, and a caller who prefers to encode the call themselves against the
 * published ABIs should do exactly that; this is a convenience, not a
 * dependency.
 *
 * Callers must still check the returned `approval` step. ERC-20 spending needs
 * an allowance, and a swap sent without one simply reverts.
 */

export const dynamic = "force-dynamic";

export function OPTIONS(): NextResponse {
  return preflight();
}

const ACTIONS = ["buy", "sell", "launch"] as const;
type Action = (typeof ACTIONS)[number];

interface TxRequest {
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly chainId: number;
}

function tx(to: string, data: string, chainId: number, value = 0n): TxRequest {
  return { to, data, value: value.toString(), chainId };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  return handle(request, 60, async () => {
    const { action: raw } = await context.params;
    const action = raw.toLowerCase() as Action;
    if (!ACTIONS.includes(action)) {
      return fail("not_found", `Unknown action "${raw}". Expected buy, sell or launch.`);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return fail("bad_request", "Expected a JSON body.");
    }

    // A caller sending a key has misunderstood the model badly enough that we
    // should refuse loudly rather than quietly ignore the field.
    for (const banned of ["privateKey", "private_key", "mnemonic", "seed", "secret"]) {
      if (banned in body) {
        return fail(
          "bad_request",
          "This API never accepts private keys, mnemonics or secrets. Remove that field — transactions are returned unsigned for your wallet to sign.",
        );
      }
    }

    const chain = getChain("arc");

    if (action === "launch") {
      return buildLaunch(body, chain);
    }
    return buildSwap(action, body, chain);
  });
}

async function buildSwap(
  action: "buy" | "sell",
  body: Record<string, unknown>,
  chain: ReturnType<typeof getChain>,
): Promise<NextResponse> {
  const token = parseAddress(String(body["token"] ?? ""));
  const sender = parseAddress(String(body["sender"] ?? ""));
  const recipient = parseAddress(String(body["recipient"] ?? body["sender"] ?? ""));
  const amountRaw = String(body["amount"] ?? "");
  const minOutRaw = String(body["minimumReceived"] ?? "");

  if (token === null) return fail("invalid_address", "`token` must be a 0x address.");
  if (sender === null) return fail("invalid_address", "`sender` must be a 0x address.");
  if (recipient === null) return fail("invalid_address", "`recipient` must be a 0x address.");
  if (!/^\d+$/.test(amountRaw) || amountRaw === "0") {
    return fail("invalid_parameter", "`amount` must be a positive integer in base units.");
  }
  if (!/^\d+$/.test(minOutRaw)) {
    return fail(
      "invalid_parameter",
      "`minimumReceived` is required, in base units. Get it from /api/v1/quote. Sending 0 would accept any price.",
    );
  }

  const market =
    (await indexedToken(token).catch(() => null)) ??
    (await fetchToken(arcPublicClient(), token as Hex).catch(() => null));
  if (market === null) return fail("not_found", "No Arcanium market for that address.");

  const amountIn = BigInt(amountRaw);
  const tokenIn = action === "buy" ? market.pairToken : market.token;
  const tokenOut = action === "buy" ? market.token : market.pairToken;

  // Is an allowance already in place? Reported, not assumed — a caller that
  // skips a needed approval just gets a revert.
  let allowance = 0n;
  try {
    allowance = await arcPublicClient().readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: "allowance",
      args: [sender as Hex, chain.uniswap.swapRouter],
    });
  } catch {
    allowance = 0n;
  }

  const needsApproval = allowance < amountIn;
  const approval = needsApproval
    ? tx(
        tokenIn,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [chain.uniswap.swapRouter, amountIn],
        }),
        chain.id,
      )
    : null;

  const swap = tx(
    chain.uniswap.swapRouter,
    encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: chain.poolFee,
          recipient: recipient as Hex,
          amountIn,
          amountOutMinimum: BigInt(minOutRaw),
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
    chain.id,
  );

  return ok(
    {
      action,
      market: market.token,
      // Ordered: send approval first when present, then the swap.
      steps: approval === null ? [{ kind: "swap", transaction: swap }] : [
        { kind: "approval", transaction: approval },
        { kind: "swap", transaction: swap },
      ],
      allowance: { current: allowance.toString(), required: amountIn.toString(), sufficient: !needsApproval },
    },
    { chainId: chain.id, signing: "none — sign and broadcast these with your own wallet" },
    0,
  );
}

function buildLaunch(
  body: Record<string, unknown>,
  chain: ReturnType<typeof getChain>,
): NextResponse {
  const name = String(body["name"] ?? "").trim();
  const symbol = String(body["symbol"] ?? "").trim();
  const metadataUri = String(body["metadataUri"] ?? "");
  const creatorBuyRaw = String(body["initialBuy"] ?? "0");
  const feeRecipient = parseAddress(String(body["feeRecipient"] ?? "")) ?? "0x0000000000000000000000000000000000000000";
  const modeRaw = String(body["rewardMode"] ?? "standard").toLowerCase();

  if (name === "" || name.length > 48) {
    return fail("invalid_parameter", "`name` is required and must be 48 characters or fewer.");
  }
  const ticker = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (ticker.length < 2) {
    return fail("invalid_parameter", "`symbol` must be 2–10 letters or digits.");
  }
  if (!/^\d+$/.test(creatorBuyRaw)) {
    return fail("invalid_parameter", "`initialBuy` must be an integer in pair-asset base units.");
  }

  // A non-zero tax is refused outright, not clamped. A token carrying one
  // cannot be sold: Uniswap v3 takes a sell's input by transferring into the
  // pool and then checking it received the promised amount, and the tax skims
  // that very transfer, so every sell reverts with IIA. Building that
  // transaction would be handing an integrator a honeypot factory.
  const taxRaw = String(body["taxBps"] ?? "0");
  if (!/^\d+$/.test(taxRaw)) {
    return fail("invalid_parameter", "`taxBps` must be an integer.");
  }
  if (BigInt(taxRaw) !== 0n) {
    return fail(
      "invalid_parameter",
      "`taxBps` must be 0 on this endpoint. It builds a Uniswap v3 launch, and a v3 token carrying a transfer tax cannot be sold: the tax skims the transfer into the pool, the pool's input check fails, and every sell reverts. Uniswap v4 launches do support a tax — the hook takes it inside the swap — and are available from the launch form.",
    );
  }

  const MODES: Record<string, number> = { standard: 0, divium: 1, arcane: 2 };
  const mode = MODES[modeRaw];
  if (mode === undefined) {
    return fail("invalid_parameter", "`rewardMode` must be standard, divium or arcane.");
  }

  const factory = chain.factories[0];
  if (factory === undefined) {
    return fail("upstream_unavailable", "No launch factory is configured for this deployment.");
  }

  const creatorBuy = BigInt(creatorBuyRaw);
  // Ten minutes is generous for a wallet round trip and short enough that a
  // forgotten, half-signed launch cannot execute much later at a stale price.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const launch = tx(
    factory,
    encodeFunctionData({
      abi: factoryAbi,
      functionName: "launch",
      args: [
        {
          name,
          symbol: ticker,
          metadataUri,
          pairToken: chain.quote.address,
          creatorBuyAmount: creatorBuy,
          minTokensOut: 0n,
          deadline,
          feeRecipient: feeRecipient as Hex,
          taxBps: 0n,
          mode,
        },
      ],
    }),
    chain.id,
  );

  const steps =
    creatorBuy > 0n
      ? [
          {
            kind: "approval",
            transaction: tx(
              chain.quote.address,
              encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [factory, creatorBuy],
              }),
              chain.id,
            ),
          },
          { kind: "launch", transaction: launch },
        ]
      : [{ kind: "launch", transaction: launch }];

  return ok(
    {
      action: "launch",
      steps,
      launch: {
        name,
        symbol: ticker,
        rewardMode: modeRaw,
        taxBps: Number(taxRaw),
        pair: chain.quote.symbol,
        supply: { units: (1_000_000_000n * 10n ** 18n).toString(), decimals: 18 },
        initialBuy: { units: creatorBuy.toString(), decimals: chain.quote.decimals },
        deadline: deadline.toString(),
      },
    },
    {
      chainId: chain.id,
      signing: "none — sign and broadcast these with your own wallet",
      note: "Launching costs no protocol fee; you pay Arc gas only. The reward mode is fixed permanently at launch.",
    },
    0,
  );
}
