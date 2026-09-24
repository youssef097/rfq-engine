import { expect, test } from "bun:test";
import type { Outcome } from "../../src/domain/types";
import { available, escrow, reserved, transfer } from "../../src/storage/index";
import { TestRig } from "../support/fixtures";

function ledgerSnapshot(rig: TestRig) {
  const { balances, journal } = rig.engine.snapshot();
  if (!balances || !journal)
    throw new Error("Snapshot must include balances and journal");
  return { balances, journal };
}

test("audit rejects a historical overdraft even when final journal balances reconcile", () => {
  const rig = new TestRig();
  try {
    const before = ledgerSnapshot(rig);
    // These entries net to zero but spend from a reservation before it was
    // funded. Looking only at ending balances would accept the history.
    rig.engine.store.transaction(() => {
      for (const [source, destination] of [
        [reserved("unfunded"), available("taker")],
        [available("taker"), reserved("unfunded")],
      ] as const) {
        rig.engine.store.run(
          "INSERT INTO journal(source,destination,amount,reason,reference) VALUES(?,?,?,?,?)",
          source,
          destination,
          1n,
          "test_history",
          "unfunded",
        );
      }
    });
    expect(ledgerSnapshot(rig).balances).toEqual(before.balances);
    expect(() => rig.engine.audit()).toThrow("Historical overdraft");
  } finally {
    rig.close();
  }
});

test("audit counts duplicate reserve and refund pairs despite unchanged balances", () => {
  const rig = new TestRig();
  try {
    const request = rig.request();
    const quote = rig.quote(request);
    rig.engine.cancelRequest("taker", rig.command(), {
      requestId: request.id,
    });
    expect(rig.engine.audit().ok).toBe(true);
    const before = ledgerSnapshot(rig);
    // Both distinct transfer keys are already expected. Replaying the pair
    // preserves balances, so provenance must compare multiplicity, not sets.
    rig.engine.store.transaction(() => {
      const amount = quote.payout - request.stake;
      transfer(
        rig.engine.store,
        available(quote.maker),
        reserved(quote.id),
        amount,
        "reserve_quote",
        quote.id,
      );
      transfer(
        rig.engine.store,
        reserved(quote.id),
        available(quote.maker),
        amount,
        "release_quote",
        quote.id,
      );
    });
    expect(ledgerSnapshot(rig).balances).toEqual(before.balances);
    expect(() => rig.engine.audit()).toThrow("Unexpected transfer provenance");
  } finally {
    rig.close();
  }
});

test("audit compares funded position legs with the original request commitment", () => {
  const rig = new TestRig();
  try {
    const { request, quote } = rig.offer();
    const position = rig.engine.position(rig.accept(request, quote).id);
    expect(rig.engine.audit().ok).toBe(true);
    const before = ledgerSnapshot(rig);
    rig.engine.store.transaction(() => {
      // Bypass only the immutable row guard to model persisted term corruption.
      rig.engine.store.run("DROP TRIGGER position_legs_no_update");
      rig.engine.store.run(
        "UPDATE position_legs SET side='NO' WHERE position_id=? AND leg_index=0",
        position.id,
      );
    });
    const after = ledgerSnapshot(rig);
    expect(after.balances).toEqual(before.balances);
    expect(after.journal).toEqual(before.journal);
    expect(() => rig.engine.audit()).toThrow("Partial or substituted position");
  } finally {
    rig.close();
  }
});

const invalidSettlements: {
  rule: string;
  results: Outcome[];
  state: "WON" | "LOST" | "VOID";
}[] = [
  {
    rule: "loss precedes void",
    results: ["VOID", "YES", "YES"],
    state: "VOID",
  },
  { rule: "void prevents a win", results: ["VOID", "NO", "YES"], state: "WON" },
  {
    rule: "all matching legs win",
    results: ["YES", "NO", "YES"],
    state: "LOST",
  },
];

for (const { rule, results, state } of invalidSettlements) {
  test(`audit independently enforces ${rule} for a fully backed settlement`, () => {
    const rig = new TestRig();
    try {
      const { request, quote } = rig.offer();
      const position = rig.engine.position(rig.accept(request, quote).id);
      const funded = rig.engine.audit().totalFunded;
      rig.clock.set(11_000);
      for (const [index, result] of results.entries())
        rig.engine.proposeResult("oracle", rig.command(), {
          marketId: `market_${index}`,
          result,
          evidence: "audit payoff fixture",
        });
      rig.clock.set(12_000);
      for (const [index] of results.entries())
        rig.engine.finalizeResult("keeper", rig.command(), {
          marketId: `market_${index}`,
        });
      expect(rig.engine.audit().ok).toBe(true);

      // Model a bug in settlement without calling its payoff calculator. The
      // SQL constraints, balances, and journal all agree on the wrong outcome;
      // the auditor must derive the result independently from the final legs.
      rig.engine.store.transaction(() => {
        if (state === "VOID") {
          transfer(
            rig.engine.store,
            escrow(position.id),
            available(position.taker),
            position.stake,
            "refund_taker",
            position.id,
          );
          transfer(
            rig.engine.store,
            escrow(position.id),
            available(position.maker),
            position.makerCollateral,
            "refund_maker",
            position.id,
          );
        } else {
          transfer(
            rig.engine.store,
            escrow(position.id),
            available(state === "WON" ? position.taker : position.maker),
            position.payout,
            state === "WON" ? "pay_taker" : "pay_maker",
            position.id,
          );
        }
        rig.engine.store.run(
          "UPDATE positions SET state=?,settled_at=? WHERE id=?",
          state,
          rig.clock.now(),
          position.id,
        );
        rig.engine.store.run(
          "UPDATE requests SET state='SETTLED' WHERE id=?",
          request.id,
        );
      });
      const total = ledgerSnapshot(rig).balances.reduce(
        (sum, row) => sum + (row.amount as bigint),
        0n,
      );
      expect(total).toBe(funded);
      expect(rig.engine.position(position.id).state).toBe(state);
      expect(() => rig.engine.audit()).toThrow("Wrong payoff precedence");
    } finally {
      rig.close();
    }
  });
}
