/** Shared expiry/closure transitions. Always called inside the caller's command. */
import type { CommandContext } from "../application/context";
import { DomainError } from "../domain";
import { available, balance, reserved, transfer } from "../storage/index";
import type {
  Quote,
  QuoteState,
  RequestState,
  RequestRow,
  RequestRecord,
  Market,
} from "../domain/types";
export const isOpen = (state: RequestState): boolean =>
  state === "COLLECTING" || state === "OFFERED";
export class RfqLifecycle {
  constructor(private readonly context: CommandContext) {}
  releaseQuote(quote: Quote, state: QuoteState, now: number): void {
    if (quote.state !== "LIVE" && quote.state !== "SELECTED") return;
    const request = this.context.records.require("requests", quote.requestId);
    const amount = quote.payout - request.stake;
    if (balance(this.context.store, reserved(quote.id)) !== amount)
      throw new DomainError(
        "CORRUPT_BACKING",
        "Reservation does not match the quote liability",
      );
    transfer(
      this.context.store,
      reserved(quote.id),
      available(quote.maker),
      amount,
      "release_quote",
      quote.id,
    );
    this.context.store.run(
      "UPDATE quotes SET state=? WHERE id=?",
      state,
      quote.id,
    );
    this.context.event(now, "quote", quote.id, "QUOTE_RELEASED", { state });
  }
  closeRequest(
    request: RequestRow,
    state: RequestState,
    reason: string,
    now: number,
  ): RequestRecord {
    if (!isOpen(request.state)) return this.context.records.request(request.id);
    for (const quote of this.context.store.all<Quote>(
      "SELECT * FROM quotes WHERE request_id=? AND state IN ('LIVE','SELECTED')",
      request.id,
    ))
      this.releaseQuote(
        quote,
        state === "EXPIRED" ? "EXPIRED" : "REJECTED",
        now,
      );
    this.context.store.run(
      "UPDATE requests SET state=?,reason=? WHERE id=?",
      state,
      reason,
      request.id,
    );
    this.context.event(now, "request", request.id, "REQUEST_CLOSED", {
      state,
      reason,
    });
    return this.context.records.request(request.id);
  }
  refreshRequest(request: RequestRow, now: number): RequestRow {
    if (!isOpen(request.state)) return request;
    if (now >= request.acceptanceDeadline)
      return this.closeRequest(request, "EXPIRED", "ACCEPTANCE_DEADLINE", now);
    if (
      request.selectedQuoteId &&
      now >=
        this.context.records.require("quotes", request.selectedQuoteId)
          .expiresAt
    )
      return this.closeRequest(
        request,
        "EXPIRED",
        "SELECTED_QUOTE_EXPIRED",
        now,
      );
    for (const market of this.context.store.all<
      Market & { marketTermsHash: string }
    >(
      "SELECT m.*,l.market_terms_hash FROM request_legs l JOIN markets m ON m.id=l.market_id WHERE l.request_id=? ORDER BY l.leg_index",
      request.id,
    )) {
      if (
        market.halted ||
        market.state !== "UNRESOLVED" ||
        now >= market.tradingClosesAt ||
        market.termsHash !== market.marketTermsHash
      )
        return this.closeRequest(request, "REJECTED", "INVALID_LEG", now);
    }
    return request;
  }
}
