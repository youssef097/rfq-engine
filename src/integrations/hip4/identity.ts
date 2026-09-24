import { DomainError, integer } from "../../domain";
import type { Hip4Binding, Hip4Network } from "../../domain/hip4-binding";
export const HIP4_INFO_ENDPOINTS: Readonly<Record<Hip4Network, string>> = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info",
};

const ASSET_OFFSET = 100_000_000n;
const SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
export function networkInput(value: unknown): Hip4Network {
  if (value !== "mainnet" && value !== "testnet") {
    throw new DomainError(
      "INVALID_INPUT",
      "HIP-4 network must be mainnet or testnet",
    );
  }
  return value;
}

export function id(value: unknown, name: string): number {
  return integer(value, name, 0, Number.MAX_SAFE_INTEGER);
}

/** Network is part of identity; labels and question display names are not IDs. */
export function hip4MarketId(binding: Hip4Binding): string {
  const network = networkInput(binding.network);
  hip4Side(binding.outcome, 1);
  return `hip4:${network}:${binding.outcome}`;
}

/** Official outcome encoding and coin/token/exchange-asset namespaces. */
export function hip4Side(
  outcome: number,
  side: 0 | 1,
): {
  outcome: number;
  side: 0 | 1;
  encoding: number;
  coin: string;
  token: string;
  assetId: number;
} {
  id(outcome, "outcome");
  if (side !== 0 && side !== 1)
    throw new DomainError("INVALID_INPUT", "Outcome side must be 0 or 1");
  const encoded = BigInt(outcome) * 10n + BigInt(side);
  const asset = ASSET_OFFSET + encoded;
  if (encoded > SAFE_INTEGER || asset > SAFE_INTEGER) {
    throw new DomainError(
      "INVALID_INPUT",
      "Outcome encoding or exchange asset ID exceeds safe integer range",
    );
  }
  const encoding = Number(encoded);
  return {
    outcome,
    side,
    encoding,
    coin: `#${encoded}`,
    token: `+${encoded}`,
    assetId: Number(asset),
  };
}

/** Accept only a canonical coin for this binding, preserving the ordered side. */
export function sideForCoin(binding: Hip4Binding, coin: unknown): 0 | 1 {
  if (typeof coin !== "string")
    throw new DomainError("INVALID_INPUT", "Outcome coin must be a string");
  for (const side of [0, 1] as const)
    if (coin === hip4Side(binding.outcome, side).coin) return side;
  throw new DomainError(
    "INVALID_INPUT",
    "Coin does not identify either side of the bound outcome",
  );
}
