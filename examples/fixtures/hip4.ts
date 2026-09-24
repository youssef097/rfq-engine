/** Pinned public observations for reproducible offline demos, never a live feed. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical, invariant } from "../../src/domain/index";
import {
  hip4MarketId,
  validateHip4Binding,
  type Hip4Binding,
} from "../../src/integrations/hip4/index";
import type { MarketInput } from "../../src/domain/types";

interface RawOutcome {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: [{ name: string }, { name: string }];
  quoteToken: string;
  venue?: string;
  deployerFeeScale?: string;
}
interface Snapshot {
  capturedAt: string;
  network: "mainnet";
  endpoint: string;
  responseSha256: string;
  outcomes: RawOutcome[];
  questions: NonNullable<Hip4Binding["question"]>[];
  quoteAsset: {
    responseSha256: string;
    token: {
      name: string;
      index: number;
      weiDecimals: number;
      szDecimals: number;
      tokenId: string;
    };
  };
}
const fixtureRoot = new URL("../../fixtures/", import.meta.url);
const read = (file: string): string =>
  readFileSync(new URL(file, fixtureRoot), "utf8");
function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
export const hip4Snapshot = freezeJson(
  JSON.parse(read("hip4-mainnet-2026-09-23.json")) as Snapshot,
);
const rawOutcomes = read("outcomeMeta.response.json");
const rawSpot = read("spotMeta.response.json");
const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
invariant(
  sha(rawOutcomes) === hip4Snapshot.responseSha256,
  "Pinned outcomeMeta checksum mismatch",
);
invariant(
  sha(rawSpot) === hip4Snapshot.quoteAsset.responseSha256,
  "Pinned spotMeta checksum mismatch",
);
const captured = JSON.parse(rawOutcomes) as {
  outcomes: RawOutcome[];
  questions: NonNullable<Hip4Binding["question"]>[];
};
const capturedSpot = JSON.parse(rawSpot) as {
  tokens: Snapshot["quoteAsset"]["token"][];
};
invariant(
  new Set(captured.outcomes.map((row) => row.outcome)).size ===
    captured.outcomes.length,
  "Duplicate captured outcome ID",
);
invariant(
  new Set(captured.questions.map((row) => row.question)).size ===
    captured.questions.length,
  "Duplicate captured question ID",
);
for (const row of hip4Snapshot.outcomes)
  invariant(
    canonical(row) ===
      canonical(captured.outcomes.find((r) => r.outcome === row.outcome)),
    "Selected outcome differs from captured metadata",
  );
for (const row of hip4Snapshot.questions)
  invariant(
    canonical(row) ===
      canonical(captured.questions.find((r) => r.question === row.question)),
    "Selected question differs from captured metadata",
  );
invariant(
  canonical(hip4Snapshot.quoteAsset.token) ===
    canonical(
      capturedSpot.tokens.find(
        (row) => row.index === hip4Snapshot.quoteAsset.token.index,
      ),
    ),
  "Quote asset differs from captured metadata",
);

const DEMO_OUTCOMES = [1209, 1210, 1211] as const;
export const DEMO_MARKET_IDS = DEMO_OUTCOMES.map(
  (outcome) => `hip4:mainnet:${outcome}`,
) as [string, string, string];
export const DEMO_TIMES = {
  requestedAt: Date.parse(hip4Snapshot.capturedAt),
  responseDeadline: Date.parse(hip4Snapshot.capturedAt) + 2_000,
  acceptanceDeadline: Date.parse(hip4Snapshot.capturedAt) + 10_000,
  shortQuoteExpiry: Date.parse(hip4Snapshot.capturedAt) + 6_000,
  tradingClosesAt: Date.parse("2026-10-01T00:00:00Z"),
  resolveAfter: Date.parse("2026-10-01T00:00:00Z"),
  disputePeriod: 3_600_000,
  adjudicationPeriod: 3_600_000,
  challengeDeadline: Date.parse("2026-10-01T01:00:00Z"),
  fallbackAt: Date.parse("2026-10-03T00:00:00Z"),
} as const;

export function fixtureBinding(outcome: number): Hip4Binding {
  const raw = hip4Snapshot.outcomes.find((row) => row.outcome === outcome);
  invariant(raw, "Unknown selected fixture outcome");
  const questions = captured.questions.filter(
    (q) =>
      q.fallbackOutcome === outcome ||
      q.namedOutcomes.includes(outcome) ||
      q.settledNamedOutcomes.includes(outcome),
  );
  invariant(questions.length <= 1, "Ambiguous captured question membership");
  return validateHip4Binding({
    network: hip4Snapshot.network,
    ...raw,
    venue: raw.venue ?? null,
    deployerFeeScale: raw.deployerFeeScale ?? null,
    question: questions[0] ?? null,
    source: {
      endpoint: hip4Snapshot.endpoint,
      capturedAt: Date.parse(hip4Snapshot.capturedAt),
      sha256: hip4Snapshot.responseSha256,
    },
  });
}

export function demoMarkets(
  oracle = "oracle",
  arbiter = "arbiter",
): MarketInput[] {
  return DEMO_OUTCOMES.map((outcome) => {
    const hip4 = fixtureBinding(outcome);
    invariant(
      hip4.description.split("|").includes("time:20261001-0000"),
      "Demo expiry no longer matches captured contract",
    );
    return {
      id: hip4MarketId(hip4),
      description: hip4.description || hip4.name,
      hip4,
      tradingClosesAt: DEMO_TIMES.tradingClosesAt,
      resolveAfter: DEMO_TIMES.resolveAfter,
      disputePeriod: DEMO_TIMES.disputePeriod,
      adjudicationPeriod: DEMO_TIMES.adjudicationPeriod,
      fallbackAt: DEMO_TIMES.fallbackAt,
      oracle,
      arbiter,
    };
  });
}
