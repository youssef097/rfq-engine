/** Disputes, arbitration and deadline finality do not move collateral. */
import { DomainError, boundedText, identifier } from "../domain/index";
import type { Market } from "../domain/types";
import { readMarket, recordFinalResult } from "./market-state";
import { fields, result } from "./validation";
import type {
  ArbitrateResultArgs,
  DisputeResultArgs,
  FinalizeResultArgs,
  ResolutionHost,
} from "./types";

export function disputeResult(
  host: ResolutionHost,
  actor: string,
  commandId: string,
  args: DisputeResultArgs,
): Market {
  const raw = fields(args, ["marketId", "reason"]);
  const marketId = identifier(raw.marketId, "marketId");
  const reason = boundedText(raw.reason, "reason", 1024);
  return host.command(
    actor,
    commandId,
    { op: "disputeResult", marketId, reason },
    (now) => {
      const market = readMarket(host, marketId);
      const holder = host.store.get<{ present: number }>(
        "SELECT 1 AS present FROM positions p JOIN position_legs pl ON pl.position_id = p.id " +
          "WHERE pl.market_id = ? AND p.state = 'OPEN' AND (p.taker = ? OR p.maker = ?) LIMIT 1",
        marketId,
        actor,
        actor,
      );
      if (!holder) {
        throw new DomainError(
          "FORBIDDEN",
          "Only an open position's taker or maker may dispute",
        );
      }
      if (market.state !== "PROPOSED" || market.challengeDeadline === null) {
        throw new DomainError(
          "INVALID_STATE",
          "Only a proposed result may be disputed",
        );
      }
      if (now >= market.challengeDeadline) {
        throw new DomainError(
          "OUTSIDE_WINDOW",
          "The challenge window has closed",
        );
      }
      // Neither deadline changes: a participant cannot restart the escrow clock.
      host.store.run(
        "UPDATE markets SET state = 'DISPUTED' WHERE id = ?",
        marketId,
      );
      host.event(now, "market", marketId, "RESULT_DISPUTED", {
        actor,
        reason,
        challengeDeadline: market.challengeDeadline,
        fallbackAt: market.fallbackAt,
      });
      return readMarket(host, marketId);
    },
  );
}

/** Recovery calls this inside its existing transaction. */
export function finalizeMarket(
  host: ResolutionHost,
  marketId: string,
  now: number,
): boolean {
  const market = readMarket(host, marketId);
  if (market.state === "FINAL") return false;
  // An uncontested outcome cannot change merely because its keeper ran late.
  if (
    market.state === "PROPOSED" &&
    market.challengeDeadline !== null &&
    now >= market.challengeDeadline
  ) {
    recordFinalResult(
      host,
      market,
      result(market.proposedResult),
      now,
      "UNCHALLENGED",
    );
    return true;
  }
  if (now >= market.fallbackAt) {
    recordFinalResult(host, market, "VOID", now, "HARD_FALLBACK");
    return true;
  }
  return false;
}

export function finalizeResult(
  host: ResolutionHost,
  actor: string,
  commandId: string,
  args: FinalizeResultArgs,
): Market {
  const raw = fields(args, ["marketId"]);
  const marketId = identifier(raw.marketId, "marketId");
  return host.command(
    actor,
    commandId,
    { op: "finalizeResult", marketId },
    (now) => {
      const market = readMarket(host, marketId);
      if (market.state === "FINAL") return market;
      if (!finalizeMarket(host, marketId, now)) {
        throw new DomainError(
          "NOT_READY",
          "Market is not eligible for finalization",
        );
      }
      return readMarket(host, marketId);
    },
  );
}

export function arbitrateResult(
  host: ResolutionHost,
  actor: string,
  commandId: string,
  args: ArbitrateResultArgs,
): Market {
  const raw = fields(args, ["marketId", "result", "evidence"]);
  const marketId = identifier(raw.marketId, "marketId");
  const outcome = result(raw.result);
  const evidence = boundedText(raw.evidence, "evidence", 4096);
  return host.command(
    actor,
    commandId,
    { op: "arbitrateResult", marketId, result: outcome, evidence },
    (now) => {
      const market = readMarket(host, marketId);
      if (actor !== market.arbiter) {
        throw new DomainError(
          "FORBIDDEN",
          "Only the designated arbiter may decide a dispute",
        );
      }
      if (market.state === "FINAL") {
        if (outcome !== market.finalResult)
          throw new DomainError(
            "ALREADY_FINAL",
            "A final result cannot be changed",
          );
        return market;
      }
      if (market.state !== "DISPUTED") {
        throw new DomainError(
          "INVALID_STATE",
          "Arbitration requires a disputed proposal",
        );
      }
      if (now >= market.fallbackAt) {
        throw new DomainError(
          "OUTSIDE_WINDOW",
          "The hard resolution deadline has passed",
        );
      }
      recordFinalResult(host, market, outcome, now, "ARBITRATED", {
        actor,
        evidence,
      });
      return readMarket(host, marketId);
    },
  );
}
