/** Request admission and cancellation; no committed state outside a command. */
import type { CommandContext } from "../application/context";
import type { RfqLifecycle } from "./lifecycle";

import {
  DomainError,
  MAX_LEGS,
  MAX_OPEN_REQUESTS,
  arrayInput,
  digest,
  identifier,
  integer,
  money,
  objectInput,
} from "../domain";
import type { RequestRecord } from "../domain/types";
import type { CreateRequestArgs, RequestArgs } from "./types";
import { requestCommitment } from "./commitment";
export function createRequest(
  ctx: CommandContext,
  actor: string,
  commandId: string,
  args: CreateRequestArgs,
): RequestRecord {
  objectInput(args, [
    "nonce",
    "legs",
    "stake",
    "responseDeadline",
    "acceptanceDeadline",
  ]);
  const { nonce, stake, responseDeadline, acceptanceDeadline, legs } = args;
  identifier(nonce, "request nonce");
  money(stake, "stake", 1n);
  integer(responseDeadline, "response deadline", 1);
  integer(acceptanceDeadline, "acceptance deadline", 1);
  arrayInput(legs, "Ticket selections", 1, MAX_LEGS);
  const normalized = legs
    .map((leg) => {
      objectInput(leg, ["marketId", "side"]);
      identifier(leg.marketId, "market id");
      if (leg.side !== "YES" && leg.side !== "NO")
        throw new DomainError(
          "INVALID_INPUT",
          "Selection side must be YES or NO",
        );
      return { ...leg };
    })
    .sort((a, b) =>
      a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0,
    );
  if (new Set(normalized.map((l) => l.marketId)).size !== normalized.length)
    throw new DomainError(
      "DUPLICATE_LEG",
      "An outcome may appear only once, on one side",
    );
  return ctx.command(
    actor,
    commandId,
    {
      op: "createRequest",
      nonce,
      legs: normalized,
      stake,
      responseDeadline,
      acceptanceDeadline,
    },
    (now) => {
      if (!(now < responseDeadline && responseDeadline < acceptanceDeadline))
        throw new DomainError(
          "INVALID_DEADLINE",
          "Require now < response < acceptance",
        );
      if (
        ctx.store.get(
          "SELECT id FROM requests WHERE taker=? AND nonce=?",
          actor,
          nonce,
        )
      )
        throw new DomainError(
          "NONCE_USED",
          "Request identity has already been issued",
        );
      const { count } = ctx.store.get<{ count: number }>(
        "SELECT count(*) AS count FROM requests WHERE taker=? AND state IN ('COLLECTING','OFFERED')",
        actor,
      )!;
      if (count >= MAX_OPEN_REQUESTS)
        throw new DomainError(
          "CAPACITY",
          "Too many open requests; recover or cancel existing ones",
        );
      const questions = new Set<string>();
      const networks = new Set<string>();
      let hasBoundMarket = false;
      let hasUnboundMarket = false;
      const enriched = normalized.map((leg) => {
        const market = ctx.records.require("markets", leg.marketId);
        if (market.hip4) {
          hasBoundMarket = true;
          networks.add(market.hip4.network);
          if (market.hip4.question) {
            const question = `${market.hip4.network}:${market.hip4.question.question}`;
            if (questions.has(question))
              throw new DomainError(
                "SAME_HIP4_QUESTION",
                "This RFQ supports at most one selection per HIP-4 question",
              );
            questions.add(question);
          }
        } else hasUnboundMarket = true;
        if (
          market.halted ||
          market.state !== "UNRESOLVED" ||
          market.hip4?.question?.settledNamedOutcomes.includes(
            market.hip4.outcome,
          ) ||
          acceptanceDeadline > market.tradingClosesAt
        )
          throw new DomainError(
            "INVALID_LEG",
            "Market is unavailable or closes before acceptance",
          );
        return { ...leg, marketTermsHash: market.termsHash };
      });
      if (networks.size > 1 || (hasBoundMarket && hasUnboundMarket))
        throw new DomainError(
          "MIXED_MARKET_DOMAIN",
          "A ticket cannot mix networks or bound and unbound market identities",
        );
      const id = ctx.newId();
      const termsHash = digest(
        requestCommitment(
          {
            taker: actor,
            nonce,
            stake,
            responseDeadline,
            acceptanceDeadline,
          },
          enriched,
        ),
      );
      ctx.store.run(
        "INSERT INTO requests(id,taker,nonce,terms_hash,stake,response_deadline,acceptance_deadline,state,created_at) VALUES(?,?,?,?,?,?,?,'COLLECTING',?)",
        id,
        actor,
        nonce,
        termsHash,
        stake,
        responseDeadline,
        acceptanceDeadline,
        now,
      );
      for (const [index, leg] of enriched.entries())
        ctx.store.run(
          "INSERT INTO request_legs VALUES(?,?,?,?,?)",
          id,
          index,
          leg.marketId,
          leg.side,
          leg.marketTermsHash,
        );
      ctx.event(now, "request", id, "REQUEST_CREATED", { termsHash });
      return ctx.records.request(id);
    },
  );
}

export function cancelRequest(
  ctx: CommandContext,
  lifecycle: RfqLifecycle,
  actor: string,
  commandId: string,
  args: RequestArgs,
): RequestRecord {
  objectInput(args, ["requestId"]);
  const { requestId } = args;
  identifier(requestId, "request id");
  return ctx.command(
    actor,
    commandId,
    { op: "cancelRequest", requestId },
    (now) => {
      let request = ctx.records.require("requests", requestId);
      if (request.taker !== actor)
        throw new DomainError("FORBIDDEN", "Only the requester may cancel");
      if (request.state === "FILLED" || request.state === "SETTLED")
        throw new DomainError(
          "REQUEST_CONSUMED",
          "A funded position cannot be cancelled",
        );
      request = lifecycle.refreshRequest(request, now);
      return lifecycle.closeRequest(
        request,
        "CANCELLED",
        "REQUESTER_CANCELLED",
        now,
      );
    },
  );
}
