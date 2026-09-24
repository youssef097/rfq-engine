/** Firm whole-ticket quotes and their reserved maker liability. */
import type { CommandContext } from "../application/context";
import type { RfqLifecycle } from "./lifecycle";

import {
  DomainError,
  MAX_QUOTES,
  UNIT,
  identifier,
  integer,
  money,
  objectInput,
  quotePrice,
} from "../domain";
import { available, reserved, transfer } from "../storage/index";
import type { Quote, RequestRecord } from "../domain/types";
import type { SubmitQuoteArgs } from "./types";
import { isOpen } from "./lifecycle";
export function submitQuote(
  ctx: CommandContext,
  lifecycle: RfqLifecycle,
  actor: string,
  commandId: string,
  args: SubmitQuoteArgs,
): Quote | RequestRecord {
  objectInput(args, [
    "requestId",
    "requestHash",
    "payout",
    "priceE6",
    "expiresAt",
  ]);
  const { requestId, requestHash, payout, priceE6, expiresAt } = args;
  identifier(requestId, "request id");
  if (
    typeof requestHash !== "string" ||
    requestHash.length !== 64 ||
    /[^0-9a-f]/.test(requestHash)
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Request commitment must be lowercase SHA-256 hex",
    );
  money(payout, "payout", 1n);
  money(priceE6, "priceE6", 1n, UNIT);
  integer(expiresAt, "quote expiry", 1);
  return ctx.command(
    actor,
    commandId,
    { op: "submitQuote", ...args },
    (now) => {
      let request = ctx.records.require("requests", requestId);
      if (request.termsHash !== requestHash)
        throw new DomainError(
          "TERMS_MISMATCH",
          "Quote commits to a different request",
        );
      if (actor === request.taker)
        throw new DomainError(
          "SELF_QUOTE",
          "A requester cannot provide its own counterparty collateral",
        );
      request = lifecycle.refreshRequest(request, now);
      if (!isOpen(request.state)) return ctx.records.request(requestId);
      if (request.state !== "COLLECTING" || now >= request.responseDeadline)
        throw new DomainError(
          "SUBMISSION_CLOSED",
          "The response window is closed",
        );
      if (!(now < expiresAt && expiresAt <= request.acceptanceDeadline))
        throw new DomainError(
          "INVALID_DEADLINE",
          "Quote must expire within the request window",
        );
      if (
        payout <= request.stake ||
        quotePrice(request.stake, payout) !== priceE6
      )
        throw new DomainError(
          "INVALID_QUOTE",
          "Price and whole-ticket payout must describe the same funding",
        );
      for (const old of ctx.store.all<Quote>(
        "SELECT * FROM quotes WHERE request_id=? AND state='LIVE' AND expires_at<=?",
        requestId,
        now,
      ))
        lifecycle.releaseQuote(old, "EXPIRED", now);
      if (
        ctx.store.get(
          "SELECT id FROM quotes WHERE request_id=? AND maker=? AND state IN ('LIVE','SELECTED')",
          requestId,
          actor,
        )
      )
        throw new DomainError(
          "QUOTE_EXISTS",
          "Cancel the live quote before posting a replacement",
        );
      let replacesQuoteId: string | null = null;
      if (
        ctx.store.get<{ count: number }>(
          "SELECT count(*) AS count FROM quotes WHERE request_id=? AND state IN ('LIVE','SELECTED')",
          requestId,
        )!.count >= MAX_QUOTES
      ) {
        // Preserve liquidity at every future instant: a better price alone
        // cannot displace an offer that would remain executable for longer.
        // For equal worst payouts, retain the earlier selection priority.
        const displaced = ctx.store.get<Quote>(
          "SELECT * FROM quotes WHERE request_id=? AND state='LIVE' AND expires_at<=? ORDER BY payout ASC,sequence DESC LIMIT 1",
          requestId,
          expiresAt,
        );
        if (!displaced || payout <= displaced.payout)
          throw new DomainError(
            "CAPACITY",
            "A full book requires a better payout with no shorter expiry",
          );
        replacesQuoteId = displaced.id;
        lifecycle.releaseQuote(displaced, "REJECTED", now);
        ctx.fault("after_quote_displacement");
      }
      const id = ctx.newId();
      ctx.store.run(
        "INSERT INTO quotes(id,request_id,maker,request_hash,replaces_quote_id,payout,price_e6,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,?,'LIVE',?)",
        id,
        requestId,
        actor,
        requestHash,
        replacesQuoteId,
        payout,
        priceE6,
        expiresAt,
        now,
      );
      transfer(
        ctx.store,
        available(actor),
        reserved(id),
        payout - request.stake,
        "reserve_quote",
        id,
      );
      ctx.event(now, "quote", id, "QUOTE_RESERVED", { requestId });
      return ctx.records.require("quotes", id);
    },
  );
}

export function cancelQuote(
  ctx: CommandContext,
  lifecycle: RfqLifecycle,
  actor: string,
  commandId: string,
  args: { quoteId: string },
): Quote {
  objectInput(args, ["quoteId"]);
  const { quoteId } = args;
  identifier(quoteId, "quote id");
  return ctx.command(
    actor,
    commandId,
    { op: "cancelQuote", quoteId },
    (now) => {
      let quote = ctx.records.require("quotes", quoteId);
      if (actor !== quote.maker)
        throw new DomainError("FORBIDDEN", "Only the quote owner may cancel");
      const request = lifecycle.refreshRequest(
        ctx.records.require("requests", quote.requestId),
        now,
      );
      quote = ctx.records.require("quotes", quoteId);
      if (quote.state !== "LIVE" && quote.state !== "SELECTED") return quote;
      if (now >= quote.expiresAt) lifecycle.releaseQuote(quote, "EXPIRED", now);
      else if (quote.replacesQuoteId !== null)
        throw new DomainError(
          "QUOTE_LOCKED",
          "A quote that displaced another offer is firm until expiry",
        );
      else if (
        request.state !== "COLLECTING" ||
        now >= request.responseDeadline
      )
        throw new DomainError(
          "QUOTE_LOCKED",
          "Firm quotes cannot be withdrawn after collection closes",
        );
      else lifecycle.releaseQuote(quote, "CANCELLED", now);
      return ctx.records.require("quotes", quoteId);
    },
  );
}
