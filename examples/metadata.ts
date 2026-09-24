/** Public metadata and illustrative terms shared by the demo traces. */
import assert from "node:assert/strict";
import {
  convertUnitsExact,
  hip4Side,
  parseDecimalUnits,
} from "../src/integrations/hip4/index";
import { DEMO_TIMES, demoMarkets, hip4Snapshot } from "./fixtures/hip4";

export const LEDGER_DECIMALS = 6;
export const units = (amount: string): bigint =>
  parseDecimalUnits(amount, LEDGER_DECIMALS);

/** Fixed simulated identities: no private keys, wallet ownership, or signatures. */
export const ACTORS = {
  taker: "0x1111111111111111111111111111111111111111",
  makerA: "0x2222222222222222222222222222222222222222",
  makerB: "0x3333333333333333333333333333333333333333",
  makerC: "0x4444444444444444444444444444444444444444",
  oracle: "0x5555555555555555555555555555555555555555",
  arbiter: "0x6666666666666666666666666666666666666666",
  operator: "0x7777777777777777777777777777777777777777",
  keeper: "0x8888888888888888888888888888888888888888",
} as const;

// Illustrative whole-ticket offers, including two correlated BTC outcomes.
// These are fixture terms, never live executable prices or multiplied odds.
export const OFFERS = [
  { maker: ACTORS.makerA, payout: units("350") },
  { maker: ACTORS.makerB, payout: units("380") },
  { maker: ACTORS.makerC, payout: units("365") },
] as const;

export function metadataFor(selectedMarketIds: readonly string[]) {
  const nativeDecimals = hip4Snapshot.quoteAsset.token.weiDecimals;
  const utc = (timestamp: number): string => new Date(timestamp).toISOString();
  return {
    executionMode:
      "Offline local RFQ simulation using pinned public HIP-4 metadata; no native orders or funds",
    pricingNote:
      "Illustrative whole-ticket quotes for correlated selections, not live prices or a probability model",
    resolutionNote:
      "All oracle/arbiter observations are simulated; VOID means the local RFQ refund policy, not native fractional settlement",
    network: hip4Snapshot.network,
    source: {
      endpoint: hip4Snapshot.endpoint,
      capturedAt: hip4Snapshot.capturedAt,
      outcomeMetaSha256: hip4Snapshot.responseSha256,
      spotMetaSha256: hip4Snapshot.quoteAsset.responseSha256,
    },
    quoteAsset: {
      symbol: hip4Snapshot.quoteAsset.token.name,
      nativeTokenIndex: hip4Snapshot.quoteAsset.token.index,
      nativeTokenId: hip4Snapshot.quoteAsset.token.tokenId,
      nativeDecimals,
      ledgerDecimals: LEDGER_DECIMALS,
      nativeUnitsPerLedgerUnit: convertUnitsExact(
        1n,
        LEDGER_DECIMALS,
        nativeDecimals,
      ),
      sizePrecisionNote:
        "USDC amount precision only; no outcome-token lot-size claim",
    },
    timesUtc: {
      requestedAt: utc(DEMO_TIMES.requestedAt),
      responseDeadline: utc(DEMO_TIMES.responseDeadline),
      acceptanceDeadline: utc(DEMO_TIMES.acceptanceDeadline),
      shortQuoteExpiry: utc(DEMO_TIMES.shortQuoteExpiry),
      tradingClosesAt: utc(DEMO_TIMES.tradingClosesAt),
      resolveAfter: utc(DEMO_TIMES.resolveAfter),
      challengeDeadline: utc(DEMO_TIMES.challengeDeadline),
      fallbackAt: utc(DEMO_TIMES.fallbackAt),
    },
    disputePeriodMs: DEMO_TIMES.disputePeriod,
    adjudicationPeriodMs: DEMO_TIMES.adjudicationPeriod,
    simulatedActors: ACTORS,
    stakeMicroUnits: units("100"),
    illustrativeOffers: OFFERS,
    marketCatalog: demoMarkets(ACTORS.oracle, ACTORS.arbiter).map((market) => {
      const binding = market.hip4;
      assert(
        binding,
        "Every demo market must carry its captured HIP-4 binding",
      );
      return {
        marketId: market.id,
        selected: selectedMarketIds.includes(market.id),
        selectedLocalSide: selectedMarketIds.includes(market.id) ? "YES" : null,
        outcomeId: binding.outcome,
        name: binding.name,
        description: binding.description,
        quoteToken: binding.quoteToken,
        venue: binding.venue,
        sides: ([0, 1] as const).map((side) => ({
          ...hip4Side(binding.outcome, side),
          localSide: side === 0 ? "YES" : "NO",
          label: binding.sideSpecs[side].name,
        })),
      };
    }),
  };
}
