/** Halting new trading never rewrites a funded position's resolution terms. */
import type { CommandContext } from "../application/context";
import { DomainError, boundedText, identifier, objectInput } from "../domain";
import type { Market } from "../domain/types";
export function haltMarket(
  ctx: CommandContext,
  actor: string,
  commandId: string,
  args: { marketId: string; reason: string },
): Market {
  objectInput(args, ["marketId", "reason"]);
  const { marketId, reason } = args;
  identifier(marketId, "market id");
  boundedText(reason, "halt reason", 1024);
  return ctx.command(
    actor,
    commandId,
    { op: "haltMarket", marketId, reason },
    (now) => {
      if (
        actor !==
        ctx.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='operator'",
        )!.value
      )
        throw new DomainError(
          "FORBIDDEN",
          "Only the mocked market operator may halt trading",
        );
      if (!ctx.records.require("markets", marketId).halted) {
        ctx.store.run("UPDATE markets SET halted=1 WHERE id=?", marketId);
        ctx.event(now, "market", marketId, "TRADING_HALTED", {
          reason: reason,
        });
      }
      return ctx.records.require("markets", marketId);
    },
  );
}
