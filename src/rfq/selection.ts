/** Rank exact payout; an offered quote is never silently substituted. */
import type { CommandContext } from "../application/context";
import type { RfqLifecycle } from "./lifecycle";

import { DomainError, identifier, objectInput } from "../domain";
import type { Quote, RequestRecord } from "../domain/types";
import type { RequestArgs } from "./types";
export function select(
  ctx: CommandContext,
  lifecycle: RfqLifecycle,
  actor: string,
  commandId: string,
  args: RequestArgs,
): RequestRecord {
  objectInput(args, ["requestId"]);
  identifier(args.requestId, "request id");
  const { requestId } = args;
  return ctx.command(actor, commandId, { op: "select", requestId }, (now) => {
    const request = lifecycle.refreshRequest(
      ctx.records.require("requests", requestId),
      now,
    );
    if (request.state !== "COLLECTING") return ctx.records.request(requestId);
    if (now < request.responseDeadline)
      throw new DomainError(
        "COLLECTION_OPEN",
        "Selection waits until the response deadline",
      );
    for (const quote of ctx.store.all<Quote>(
      "SELECT * FROM quotes WHERE request_id=? AND state='LIVE' AND expires_at<=?",
      requestId,
      now,
    ))
      lifecycle.releaseQuote(quote, "EXPIRED", now);
    const best = ctx.store.get<Quote>(
      "SELECT * FROM quotes WHERE request_id=? AND state='LIVE' ORDER BY payout DESC,sequence ASC LIMIT 1",
      requestId,
    );
    if (!best)
      return lifecycle.closeRequest(request, "REJECTED", "NO_LIVE_QUOTES", now);
    ctx.store.run("UPDATE quotes SET state='SELECTED' WHERE id=?", best.id);
    ctx.store.run(
      "UPDATE requests SET state='OFFERED',selected_quote_id=? WHERE id=?",
      best.id,
      requestId,
    );
    ctx.event(now, "request", requestId, "QUOTE_SELECTED", {
      quoteId: best.id,
    });
    return ctx.records.request(requestId);
  });
}
