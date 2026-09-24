/** Read one indexed snapshot and verify immutable market/request terms. */
import {
  MARKET_TERMS,
  MAX_LEGS,
  canonical,
  digest,
  invariant,
} from "../domain/index";
import type { Store } from "../storage/store";
import type {
  Leg,
  Market,
  PositionRow,
  Quote,
  RequestRow,
} from "../domain/types";
import type { Books, Commitment } from "./types";

function groupBy<Row>(
  rows: Row[],
  owner: (row: Row) => string,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = owner(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** Load each relation once, avoiding queries and whole-book scans per position. */
export function readBooks(store: Store): Books {
  const markets = new Map(
    store.all<Market>("SELECT * FROM markets").map((row) => [row.id, row]),
  );
  const requests = new Map(
    store.all<RequestRow>("SELECT * FROM requests").map((row) => [row.id, row]),
  );
  const quoteRows = store.all<Quote>("SELECT * FROM quotes");
  const quotes = new Map(quoteRows.map((row) => [row.id, row]));
  const positionRows = store.all<PositionRow>("SELECT * FROM positions");
  const positions = new Map(positionRows.map((row) => [row.requestId, row]));
  invariant(
    positions.size === positionRows.length,
    "Multiple positions per request",
  );
  const requestLegs = groupBy(
    store.all<Leg & { requestId: string }>(
      "SELECT * FROM request_legs ORDER BY request_id, leg_index",
    ),
    (leg) => leg.requestId,
  );
  const positionLegs = groupBy(
    store.all<Leg & { positionId: string }>(
      "SELECT * FROM position_legs ORDER BY position_id, leg_index",
    ),
    (leg) => leg.positionId,
  );
  return {
    markets,
    requests,
    quotes,
    positions,
    requestLegs,
    positionLegs,
    quotesByRequest: groupBy(quoteRows, (quote) => quote.requestId),
  };
}

export function checkMarketTerms(markets: ReadonlyMap<string, Market>): void {
  for (const market of markets.values()) {
    invariant(
      Number.isSafeInteger(market.adjudicationPeriod) &&
        market.adjudicationPeriod > 0 &&
        market.resolveAfter +
          market.disputePeriod +
          market.adjudicationPeriod <=
          market.fallbackAt,
      "Invalid adjudication timetable",
    );
    invariant(
      market.challengeDeadline === null ||
        market.challengeDeadline + market.adjudicationPeriod <=
          market.fallbackAt,
      "Proposal leaves insufficient adjudication time",
    );
    invariant(
      market.termsHash ===
        digest(
          Object.fromEntries(
            MARKET_TERMS.map((field) => [field, market[field]]),
          ),
        ),
      "Market terms changed",
    );
  }
}

export function checkRequests(
  books: Books,
  requestCommitment: Commitment,
): void {
  const { markets, requests, quotes, positions, requestLegs, quotesByRequest } =
    books;
  for (const [id, request] of requests) {
    const legs = requestLegs.get(id) ?? [];
    invariant(
      legs.length >= 1 && legs.length <= MAX_LEGS,
      "Wrong request leg count",
    );
    invariant(
      legs.every((leg, index) => leg.legIndex === index),
      "Noncontiguous legs",
    );
    invariant(
      new Set(legs.map((leg) => leg.marketId)).size === legs.length,
      "Duplicate request selections",
    );
    invariant(
      canonical(legs.map((l) => l.marketId)) ===
        canonical(legs.map((l) => l.marketId).sort()),
      "Noncanonical selections",
    );
    invariant(
      legs.every(
        (leg) => markets.get(leg.marketId)?.termsHash === leg.marketTermsHash,
      ),
      "Leg market terms mismatch",
    );
    invariant(
      digest(requestCommitment(request, legs)) === request.termsHash,
      "Request commitment mismatch",
    );
    invariant(
      positions.has(id) ===
        (request.state === "FILLED" || request.state === "SETTLED"),
      "Partial request execution",
    );
    if (request.state === "OFFERED") {
      const selected = request.selectedQuoteId
        ? quotes.get(request.selectedQuoteId)
        : undefined;
      invariant(
        selected?.state === "SELECTED" && selected.requestId === id,
        "Offer lacks selected quote",
      );
    }
    if (request.state !== "COLLECTING" && request.state !== "OFFERED")
      invariant(
        !(quotesByRequest.get(id) ?? []).some(
          (quote) => quote.state === "LIVE" || quote.state === "SELECTED",
        ),
        "Terminal request retains reservations",
      );
  }
}
