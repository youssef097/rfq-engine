/** Market reads and final-result writes inside the caller's transaction. */
import { DomainError, identifier } from "../domain/index";
import type { Market } from "../domain/types";
import type { ResolutionHost, ResolutionResult } from "./types";

export function readMarket(host: ResolutionHost, marketId: string): Market {
  identifier(marketId, "marketId");
  const market = host.store.get<Market>(
    "SELECT * FROM markets WHERE id = ?",
    marketId,
  );
  if (!market) throw new DomainError("NOT_FOUND", "Market does not exist");
  return market;
}

export function recordFinalResult(
  host: ResolutionHost,
  market: Market,
  outcome: ResolutionResult,
  now: number,
  reason: string,
  details: { actor?: string; evidence?: string } = {},
): void {
  if (market.state === "FINAL") {
    throw new DomainError("ALREADY_FINAL", "A final result cannot be changed");
  }
  if (details.evidence === undefined) {
    host.store.run(
      "UPDATE markets SET state = 'FINAL', final_result = ? WHERE id = ?",
      outcome,
      market.id,
    );
  } else {
    host.store.run(
      "UPDATE markets SET state = 'FINAL', final_result = ?, evidence = ? WHERE id = ?",
      outcome,
      details.evidence,
      market.id,
    );
  }
  host.event(now, "market", market.id, "RESULT_FINALIZED", {
    result: outcome,
    reason,
    actor: details.actor ?? null,
    evidence: details.evidence ?? null,
  });
}
