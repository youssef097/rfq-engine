/** Validate and copy immutable metadata; this is not an oracle proof. */
import { arrayInput, DomainError, integer, objectInput } from "../../domain";
import type { Hip4Binding } from "../../domain/hip4-binding";
import { HIP4_INFO_ENDPOINTS, networkInput, id, hip4Side } from "./identity";
import { decimalParts } from "./decimals";
const MAX_DESCRIPTION = 16_384;
const MAX_MEMBERS = 4_096;
function rawText(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && !value.trim())
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      `${name} must be bounded ${allowEmpty ? "" : "nonempty "}text`,
    );
  }
  return value;
}

function memberIds(value: unknown, name: string): number[] {
  arrayInput(value, name, 0, MAX_MEMBERS);
  const result = value.map((item) => id(item, `${name} member`));
  if (new Set(result).size !== result.length) {
    throw new DomainError(
      "INVALID_INPUT",
      `${name} must not contain duplicate outcome IDs`,
    );
  }
  // Every member is an outcome, so both of its side encodings must be representable.
  for (const outcome of result) hip4Side(outcome, 1);
  return result;
}

/** Validate captured metadata without inferring missing fields or changing raw text. */
export function validateHip4Binding(raw: unknown): Hip4Binding {
  objectInput(raw, [
    "network",
    "outcome",
    "name",
    "description",
    "sideSpecs",
    "quoteToken",
    "venue",
    "deployerFeeScale",
    "question",
    "source",
  ]);
  const network = networkInput(raw.network);
  const outcome = id(raw.outcome, "outcome");
  hip4Side(outcome, 1);
  const name = rawText(raw.name, "Outcome name", 512);
  const description = rawText(
    raw.description,
    "Outcome description",
    MAX_DESCRIPTION,
    true,
  );

  arrayInput(raw.sideSpecs, "sideSpecs", 2, 2);
  const labels = raw.sideSpecs.map((spec) => {
    objectInput(spec, ["name"]);
    return { name: rawText(spec.name, "Side name", 512) };
  });
  const sideSpecs: Hip4Binding["sideSpecs"] = [labels[0]!, labels[1]!];

  if (raw.quoteToken !== "USDC") {
    throw new DomainError(
      "UNSUPPORTED_QUOTE_TOKEN",
      "This mock ledger supports USDC-quoted outcomes only",
    );
  }
  const venue = raw.venue === null ? null : rawText(raw.venue, "Venue", 128);
  let deployerFeeScale: string | null = null;
  if (raw.deployerFeeScale !== null) {
    const parts = decimalParts(raw.deployerFeeScale);
    const whole = BigInt(parts.whole);
    if (whole > 10n || (whole === 10n && /[1-9]/.test(parts.fraction))) {
      throw new DomainError(
        "INVALID_INPUT",
        "Deployer fee scale must be in [0, 10]",
      );
    }
    deployerFeeScale = raw.deployerFeeScale as string;
  }

  let question: Hip4Binding["question"] = null;
  if (raw.question !== null) {
    objectInput(raw.question, [
      "question",
      "name",
      "description",
      "fallbackOutcome",
      "namedOutcomes",
      "settledNamedOutcomes",
    ]);
    const fallbackOutcome = id(raw.question.fallbackOutcome, "fallbackOutcome");
    hip4Side(fallbackOutcome, 1);
    const namedOutcomes = memberIds(
      raw.question.namedOutcomes,
      "namedOutcomes",
    );
    const settledNamedOutcomes = memberIds(
      raw.question.settledNamedOutcomes,
      "settledNamedOutcomes",
    );
    if (
      namedOutcomes.includes(fallbackOutcome) ||
      settledNamedOutcomes.includes(fallbackOutcome)
    ) {
      throw new DomainError(
        "INVALID_INPUT",
        "Fallback outcome must be distinct from named outcomes",
      );
    }
    if (
      outcome !== fallbackOutcome &&
      !namedOutcomes.includes(outcome) &&
      !settledNamedOutcomes.includes(outcome)
    ) {
      throw new DomainError(
        "INVALID_INPUT",
        "Outcome does not belong to its supplied question",
      );
    }
    question = {
      question: id(raw.question.question, "question"),
      name: rawText(raw.question.name, "Question name", 512),
      description: rawText(
        raw.question.description,
        "Question description",
        MAX_DESCRIPTION,
        true,
      ),
      fallbackOutcome,
      namedOutcomes,
      settledNamedOutcomes,
    };
  }

  objectInput(raw.source, ["endpoint", "capturedAt", "sha256"]);
  if (raw.source.endpoint !== HIP4_INFO_ENDPOINTS[network]) {
    throw new DomainError(
      "INVALID_INPUT",
      "Metadata source endpoint does not match the stated network",
    );
  }
  if (
    typeof raw.source.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.source.sha256)
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      "Metadata source requires a lowercase SHA-256 hex digest",
    );
  }
  return {
    network,
    outcome,
    name,
    description,
    sideSpecs,
    quoteToken: "USDC",
    venue,
    deployerFeeScale,
    question,
    source: {
      endpoint: raw.source.endpoint,
      capturedAt: integer(raw.source.capturedAt, "capturedAt"),
      sha256: raw.source.sha256,
    },
  };
}
