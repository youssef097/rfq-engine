/** Validate oracle proposals before recording one complete challenge window. */
import { binaryResultFromFraction, hip4Side } from "../integrations/hip4/index";
import {
  DomainError,
  arrayInput,
  boundedText,
  identifier,
  integer,
} from "../domain/index";
import type { Market } from "../domain/types";
import { readMarket } from "./market-state";
import { fields, result } from "./validation";
import type {
  ProposeResultArgs,
  ProposeHip4ResultArgs,
  ResolutionHost,
  ResolutionResult,
} from "./types";

export function proposeResult(
  host: ResolutionHost,
  actor: string,
  commandId: string,
  args: ProposeResultArgs,
): Market {
  const raw = fields(args, ["marketId", "result", "evidence"]);
  const marketId = identifier(raw.marketId, "marketId");
  const outcome = result(raw.result);
  const evidence = boundedText(raw.evidence, "evidence", 4096);
  const payload = {
    op: "proposeResult",
    marketId,
    result: outcome,
    evidence,
  };
  return host.command(actor, commandId, payload, (now) =>
    proposeMarket(
      host,
      actor,
      readMarket(host, marketId),
      outcome,
      evidence,
      now,
    ),
  );
}

export function proposeHip4Result(
  host: ResolutionHost,
  actor: string,
  commandId: string,
  args: ProposeHip4ResultArgs,
): Market {
  const raw = fields(args, [
    "network",
    "outcome",
    "settleFraction",
    "nameAndDescription",
    "sideNames",
    "evidence",
  ]);
  if (raw.network !== "mainnet" && raw.network !== "testnet") {
    throw new DomainError("INVALID_INPUT", "Invalid HIP-4 network");
  }
  const network = raw.network;
  const outcome = integer(raw.outcome, "outcome", 0, Number.MAX_SAFE_INTEGER);
  hip4Side(outcome, 1); // Reject an ID whose exchange encoding loses precision.
  const marketId = `hip4:${network}:${outcome}`;
  const resolution = binaryResultFromFraction(raw.settleFraction);
  const settleFraction = raw.settleFraction as string;
  arrayInput(raw.nameAndDescription, "nameAndDescription", 2, 2);
  const name = boundedText(raw.nameAndDescription[0], "Outcome name", 512);
  const description = raw.nameAndDescription[1];
  // Native descriptions may be empty; otherwise preserve every raw character.
  if (typeof description !== "string" || description.length > 16_384) {
    throw new DomainError("INVALID_INPUT", "Invalid outcome description");
  }
  arrayInput(raw.sideNames, "sideNames", 2, 2);
  const sideNames: [string, string] = [
    boundedText(raw.sideNames[0], "Side name", 512),
    boundedText(raw.sideNames[1], "Side name", 512),
  ];
  const evidence = boundedText(raw.evidence, "evidence", 4096);
  const observation: ProposeHip4ResultArgs = {
    network,
    outcome,
    settleFraction,
    nameAndDescription: [name, description],
    sideNames,
    evidence,
  };
  return host.command(
    actor,
    commandId,
    { op: "proposeHip4Result", ...observation },
    (now) => {
      const market = readMarket(host, marketId);
      const binding = market.hip4;
      if (!binding) {
        throw new DomainError(
          "HIP4_BINDING_REQUIRED",
          "Native observations require a frozen HIP-4 market binding",
        );
      }
      if (
        binding.network !== network ||
        binding.outcome !== outcome ||
        binding.name !== name ||
        binding.description !== description ||
        binding.sideSpecs[0].name !== sideNames[0] ||
        binding.sideSpecs[1].name !== sideNames[1]
      ) {
        throw new DomainError(
          "HIP4_METADATA_MISMATCH",
          "Observation identity and ordered raw metadata must match the frozen market",
        );
      }
      return proposeMarket(
        host,
        actor,
        market,
        resolution,
        evidence,
        now,
        observation,
      );
    },
  );
}

/** The command caller owns the transaction, including metadata validation. */
function proposeMarket(
  host: ResolutionHost,
  actor: string,
  market: Market,
  outcome: ResolutionResult,
  evidence: string,
  now: number,
  hip4Observation?: ProposeHip4ResultArgs,
): Market {
  if (actor !== market.oracle) {
    throw new DomainError(
      "FORBIDDEN",
      "Only the designated oracle may propose a result",
    );
  }
  if (market.state !== "UNRESOLVED") {
    throw new DomainError(
      "INVALID_STATE",
      "Only an unresolved market accepts a proposal",
    );
  }
  const challengeDeadline = now + market.disputePeriod;
  if (
    now < market.resolveAfter ||
    now >= market.fallbackAt ||
    challengeDeadline + market.adjudicationPeriod > market.fallbackAt
  ) {
    throw new DomainError(
      "OUTSIDE_WINDOW",
      "Proposal must leave full dispute and adjudication periods before the hard deadline",
    );
  }
  host.store.run(
    "UPDATE markets SET state = 'PROPOSED', proposed_result = ?, challenge_deadline = ?, evidence = ? WHERE id = ?",
    outcome,
    challengeDeadline,
    evidence,
    market.id,
  );
  host.event(now, "market", market.id, "RESULT_PROPOSED", {
    actor,
    result: outcome,
    evidence,
    challengeDeadline,
    ...(hip4Observation ? { hip4Observation } : {}),
  });
  return readMarket(host, market.id);
}
