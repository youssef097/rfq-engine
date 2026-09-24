/** Whole-ticket payout stays in one visible, synchronous transaction body. */
import { DomainError, identifier } from "../domain/index";
import { available, balance, escrow, transfer } from "../storage/index";
import type { Position } from "../domain/types";
import { fields } from "./validation";
import type { ResolutionHost, ResolutionResult, SettleArgs } from "./types";

interface SettlementLeg {
  side: "YES" | "NO";
  state: string;
  finalResult: ResolutionResult | null;
}

/** Atomic with the host receipt; repeated settlement never transfers again. */
export function settlePosition(
  host: ResolutionHost,
  positionId: string,
  now: number,
): Position {
  identifier(positionId, "positionId");
  const position = host.readPosition(positionId);
  if (position.state !== "OPEN") return position;
  const legs = host.store.all<SettlementLeg>(
    "SELECT pl.side, m.state, m.final_result FROM position_legs pl " +
      "JOIN markets m ON m.id = pl.market_id WHERE pl.position_id = ? ORDER BY pl.leg_index",
    positionId,
  );
  if (legs.length === 0)
    throw new DomainError(
      "INVALID_STATE",
      "An open position must contain at least one leg",
    );
  if (legs.some((leg) => leg.state !== "FINAL")) {
    throw new DomainError(
      "NOT_FINAL",
      "Every leg must be final before the ticket settles",
    );
  }
  if (
    legs.some((leg) => !["YES", "NO", "VOID"].includes(leg.finalResult ?? ""))
  ) {
    throw new DomainError("INVALID_STATE", "Final market outcome is invalid");
  }
  const hasLoss = legs.some(
    (leg) =>
      (leg.finalResult === "YES" || leg.finalResult === "NO") &&
      leg.finalResult !== leg.side,
  );
  const hasVoid = legs.some((leg) => leg.finalResult === "VOID");
  const outcome = hasLoss ? "LOST" : hasVoid ? "VOID" : "WON";
  const pot = escrow(positionId);
  if (
    position.stake + position.makerCollateral !== position.payout ||
    balance(host.store, pot) !== position.payout
  ) {
    throw new DomainError(
      "ESCROW_MISMATCH",
      "Position escrow must exactly cover its payout",
    );
  }
  if (outcome === "WON") {
    transfer(
      host.store,
      pot,
      available(position.taker),
      position.payout,
      "pay_taker",
      positionId,
    );
    host.fault("after_settlement_transfer");
  } else if (outcome === "LOST") {
    transfer(
      host.store,
      pot,
      available(position.maker),
      position.payout,
      "pay_maker",
      positionId,
    );
    host.fault("after_settlement_transfer");
  } else {
    transfer(
      host.store,
      pot,
      available(position.taker),
      position.stake,
      "refund_taker",
      positionId,
    );
    host.fault("after_settlement_transfer");
    transfer(
      host.store,
      pot,
      available(position.maker),
      position.makerCollateral,
      "refund_maker",
      positionId,
    );
  }
  host.store.run(
    "UPDATE positions SET state = ?, settled_at = ? WHERE id = ? AND state = 'OPEN'",
    outcome,
    now,
    positionId,
  );
  const changed = host.store.run(
    "UPDATE requests SET state = 'SETTLED' WHERE id = ? AND state = 'FILLED'",
    position.requestId,
  ).changes;
  if (changed !== 1 && changed !== 1n) {
    throw new DomainError(
      "INVALID_STATE",
      "An open position must belong to a filled request",
    );
  }
  host.event(now, "position", positionId, "POSITION_SETTLED", {
    outcome,
    payout: position.payout,
    stake: position.stake,
    makerCollateral: position.makerCollateral,
  });
  return host.readPosition(positionId);
}

export function settle(
  host: ResolutionHost,
  actor: string,
  commandId: string,
  args: SettleArgs,
): Position {
  const raw = fields(args, ["positionId"]);
  const positionId = identifier(raw.positionId, "positionId");
  return host.command(actor, commandId, { op: "settle", positionId }, (now) =>
    settlePosition(host, positionId, now),
  );
}
