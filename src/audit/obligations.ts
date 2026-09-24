/** Check quote collateral, position backing and independently derived payouts. */
import { MAX_QUOTES, canonical, invariant, quotePrice } from "../domain/index";
import { available, escrow, reserved } from "../storage/ledger";
import type { Leg } from "../domain/types";
import type { Balances, Books, ExpectTransfer } from "./types";

export function checkQuotes(
  books: Books,
  balances: Balances,
  expectTransfer: ExpectTransfer,
): void {
  const { requests, quotes, positions } = books;
  const replacedQuotes = new Set<string>();
  const activeCounts = new Map<string, number>();
  for (const [id, quote] of quotes) {
    const request = requests.get(quote.requestId);
    invariant(request, "Quote lacks request");
    const amount = quote.payout - request.stake;
    invariant(
      amount > 0n && quote.requestHash === request.termsHash,
      "Quote commitment mismatch",
    );
    invariant(
      quote.priceE6 === quotePrice(request.stake, quote.payout),
      "Quote economics mismatch",
    );
    invariant(quote.maker !== request.taker, "Self-quoted request");
    if (quote.replacesQuoteId !== null) {
      const predecessor = quotes.get(quote.replacesQuoteId);
      invariant(predecessor, "Replacement quote lacks predecessor");
      invariant(
        predecessor.requestId === quote.requestId &&
          predecessor.sequence < quote.sequence &&
          predecessor.payout < quote.payout &&
          predecessor.expiresAt <= quote.expiresAt,
        "Invalid quote replacement terms",
      );
      invariant(
        predecessor.state === "REJECTED",
        "Replaced quote was not released",
      );
      invariant(
        !replacedQuotes.has(predecessor.id),
        "Quote displaced more than once",
      );
      invariant(
        quote.state !== "CANCELLED",
        "Firm replacement quote was cancelled",
      );
      replacedQuotes.add(predecessor.id);
    }
    expectTransfer(
      available(quote.maker),
      reserved(id),
      amount,
      "reserve_quote",
      id,
    );
    const held = quote.state === "LIVE" || quote.state === "SELECTED";
    if (held) {
      const count = (activeCounts.get(quote.requestId) ?? 0) + 1;
      invariant(count <= MAX_QUOTES, "Quote book exceeds capacity");
      activeCounts.set(quote.requestId, count);
    }
    invariant(
      (balances.get(reserved(id)) ?? 0n) === (held ? amount : 0n),
      "Quote backing mismatch",
    );
    if (quote.state === "SELECTED")
      invariant(
        request.state === "OFFERED" && request.selectedQuoteId === id,
        "Orphan selected quote",
      );
    if (
      quote.state === "REJECTED" ||
      quote.state === "EXPIRED" ||
      quote.state === "CANCELLED"
    )
      expectTransfer(
        reserved(id),
        available(quote.maker),
        amount,
        "release_quote",
        id,
      );
    if (quote.state === "ACCEPTED")
      invariant(
        positions.get(quote.requestId)?.quoteId === id,
        "Accepted quote lacks position",
      );
  }
}

export function checkPositions(
  books: Books,
  balances: Balances,
  expectTransfer: ExpectTransfer,
): void {
  const { markets, requests, quotes, positions, requestLegs, positionLegs } =
    books;
  // Keep the payoff check independent of the settlement implementation: the
  // auditor must not inherit the same mistake by calling its payout calculator.
  for (const [requestId, position] of positions) {
    const request = requests.get(requestId);
    const quote = quotes.get(position.quoteId);
    invariant(request && quote, "Position references missing terms");
    invariant(
      request.selectedQuoteId === quote.id &&
        quote.state === "ACCEPTED" &&
        quote.requestId === requestId,
      "Wrong funded quote",
    );
    invariant(
      position.taker === request.taker &&
        position.maker === quote.maker &&
        position.stake === request.stake &&
        position.payout === quote.payout,
      "Position terms mismatch",
    );
    invariant(
      position.stake + position.makerCollateral === position.payout,
      "Escrow funding mismatch",
    );
    const legs = positionLegs.get(position.id) ?? [];
    const terms = (selections: Leg[]) =>
      selections.map((l) => [
        l.legIndex,
        l.marketId,
        l.side,
        l.marketTermsHash,
      ]);
    invariant(
      canonical(terms(legs)) ===
        canonical(terms(requestLegs.get(requestId) ?? [])),
      "Partial or substituted position",
    );
    expectTransfer(
      available(position.taker),
      escrow(position.id),
      position.stake,
      "fund_taker",
      position.id,
    );
    expectTransfer(
      reserved(quote.id),
      escrow(position.id),
      position.makerCollateral,
      "fund_maker",
      position.id,
    );
    const open = position.state === "OPEN";
    invariant(
      (balances.get(escrow(position.id)) ?? 0n) ===
        (open ? position.payout : 0n),
      "Position backing mismatch",
    );
    invariant(
      (request.state === "FILLED") === open,
      "Request settlement mismatch",
    );
    invariant(
      open === (position.settledAt === null),
      "Position settlement timestamp mismatch",
    );
    if (!open) {
      const outcomes = legs.map((leg) => ({
        market: markets.get(leg.marketId)!,
        side: leg.side,
      }));
      invariant(
        outcomes.every(({ market }) => market?.state === "FINAL"),
        "Premature settlement",
      );
      const loss = outcomes.some(
        ({ market, side }) =>
          market.finalResult !== side && market.finalResult !== "VOID",
      );
      const voided = outcomes.some(
        ({ market }) => market.finalResult === "VOID",
      );
      invariant(
        position.state === (loss ? "LOST" : voided ? "VOID" : "WON"),
        "Wrong payoff precedence",
      );
      if (position.state === "VOID") {
        expectTransfer(
          escrow(position.id),
          available(position.taker),
          position.stake,
          "refund_taker",
          position.id,
        );
        expectTransfer(
          escrow(position.id),
          available(position.maker),
          position.makerCollateral,
          "refund_maker",
          position.id,
        );
      } else {
        expectTransfer(
          escrow(position.id),
          available(position.state === "WON" ? position.taker : position.maker),
          position.payout,
          position.state === "WON" ? "pay_taker" : "pay_maker",
          position.id,
        );
      }
    }
  }
}
