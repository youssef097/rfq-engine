/** The complete acceptance remains one visible transaction, including all funding. */
import type { CommandContext } from "../application/context";
import type { RfqLifecycle } from "./lifecycle";

import { DomainError, digest, identifier, objectInput } from "../domain";
import {
  available,
  balance,
  escrow,
  reserved,
  transfer,
} from "../storage/index";
import type { Position, Quote, RequestRecord } from "../domain/types";
import type { AcceptArgs } from "./types";
import { requestCommitment } from "./commitment";
import { isOpen } from "./lifecycle";
export function accept(
  ctx: CommandContext,
  lifecycle: RfqLifecycle,
  actor: string,
  commandId: string,
  args: AcceptArgs,
): Position | RequestRecord {
  objectInput(args, ["requestId", "quoteId"]);
  identifier(args.requestId, "request id");
  identifier(args.quoteId, "quote id");
  const { requestId, quoteId } = args;
  return ctx.command(
    actor,
    commandId,
    { op: "accept", requestId, quoteId },
    (now) => {
      let request = ctx.records.request(requestId);
      if (actor !== request.taker)
        throw new DomainError("FORBIDDEN", "Only the requester may accept");
      if (request.state === "FILLED" || request.state === "SETTLED")
        throw new DomainError(
          "REQUEST_CONSUMED",
          "This request has already created its one position",
        );
      lifecycle.refreshRequest(request, now);
      request = ctx.records.request(requestId);
      if (!isOpen(request.state)) return request;
      if (request.state !== "OFFERED" || request.selectedQuoteId !== quoteId)
        throw new DomainError(
          "QUOTE_NOT_SELECTED",
          "Acceptance must name the exact offered quote",
        );
      const quote = ctx.records.require("quotes", quoteId);
      if (
        quote.requestId !== requestId ||
        quote.state !== "SELECTED" ||
        quote.requestHash !== request.termsHash
      )
        throw new DomainError(
          "TERMS_MISMATCH",
          "Selected quote does not match this request",
        );
      if (
        digest(requestCommitment(request, request.legs)) !== request.termsHash
      )
        throw new DomainError(
          "CORRUPT_TERMS",
          "Immutable request commitment does not reconcile",
        );
      const collateral = quote.payout - request.stake;
      if (balance(ctx.store, reserved(quoteId)) !== collateral)
        throw new DomainError(
          "CORRUPT_BACKING",
          "Maker reservation is not fully backed",
        );
      if (balance(ctx.store, available(actor)) < request.stake)
        return lifecycle.closeRequest(
          request,
          "REJECTED",
          "INSUFFICIENT_TAKER_FUNDS",
          now,
        );
      const id = ctx.newId();
      ctx.store.run(
        "INSERT INTO positions(id,request_id,quote_id,taker,maker,stake,maker_collateral,payout,state,created_at) VALUES(?,?,?,?,?,?,?,?,'OPEN',?)",
        id,
        requestId,
        quoteId,
        actor,
        quote.maker,
        request.stake,
        collateral,
        quote.payout,
        now,
      );
      transfer(
        ctx.store,
        available(actor),
        escrow(id),
        request.stake,
        "fund_taker",
        id,
      );
      ctx.fault("after_stake_debit");
      transfer(
        ctx.store,
        reserved(quoteId),
        escrow(id),
        collateral,
        "fund_maker",
        id,
      );
      ctx.fault("after_maker_debit");
      for (const leg of request.legs) {
        ctx.store.run(
          "INSERT INTO position_legs VALUES(?,?,?,?,?)",
          id,
          leg.legIndex,
          leg.marketId,
          leg.side,
          leg.marketTermsHash,
        );
        ctx.fault(`after_leg:${leg.legIndex}`);
      }
      ctx.store.run("UPDATE quotes SET state='ACCEPTED' WHERE id=?", quoteId);
      ctx.store.run("UPDATE requests SET state='FILLED' WHERE id=?", requestId);
      for (const other of ctx.store.all<Quote>(
        "SELECT * FROM quotes WHERE request_id=? AND state='LIVE'",
        requestId,
      ))
        lifecycle.releaseQuote(other, "REJECTED", now);
      ctx.event(now, "position", id, "POSITION_FUNDED", {
        requestId,
        quoteId,
      });
      return ctx.records.position(id);
    },
  );
}
