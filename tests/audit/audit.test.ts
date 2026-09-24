import { expect, test } from "bun:test";
import {
  available,
  fundFixture,
  reserved,
  transfer,
} from "../../src/storage/index";
import { fixtureMarkets, TestRig } from "../support/fixtures";

test("recovery fairness survives restart and rollback during request churn", () => {
  const early = fixtureMarkets()[0]!;
  const late = {
    ...early,
    id: "late",
    tradingClosesAt: 100_000,
    resolveAfter: 110_000,
    fallbackAt: 120_000,
  };
  const rig = new TestRig({ markets: [early, late] });
  try {
    const request = rig.request({
      legs: [{ marketId: early.id, side: "YES" }],
    });
    const quote = rig.quote(request);
    rig.select(request);
    const position = rig.engine.position(rig.accept(request, quote).id);
    rig.clock.set(11_000);
    rig.engine.proposeResult("oracle", rig.command(), {
      marketId: early.id,
      result: "YES",
      evidence: "observed result",
    });
    rig.clock.set(12_000);
    rig.engine.finalizeResult("keeper", rig.command(), { marketId: early.id });
    for (let index = 0; index < 4; index += 1) {
      const command = rig.command();
      rig.engine.createRequest("unfunded_actor", command, {
        nonce: command,
        legs: [{ marketId: "late", side: "YES" }],
        stake: 1n,
        responseDeadline: rig.clock.now() + 1,
        acceptanceDeadline: rig.clock.now() + 2,
      });
      rig.clock.advance(2);
      const recoveryCommand = rig.command();
      if (index === 1) {
        const before = rig.engine.snapshot();
        rig.faultStage = "before_commit";
        expect(() =>
          rig.engine.recover("keeper", recoveryCommand, { limit: 1 }),
        ).toThrow("before_commit");
        rig.faultStage = null;
        // The attempted payout, persisted cursor, and command receipt must all
        // roll back. Retrying that same command can safely process the batch.
        expect(rig.engine.snapshot()).toEqual(before);
      }
      const result = rig.engine.recover("keeper", recoveryCommand, {
        limit: 1,
      });
      expect(
        result.requests + result.quotes + result.markets + result.positions,
      ).toBeLessThanOrEqual(1);
      if (index === 0) {
        const cursor = rig.engine.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='recovery_cursor'",
        );
        if (!cursor) throw new Error("Recovery cursor must be persisted");
        expect(cursor.value).toBe("1");
        rig.reopen();
        expect(
          rig.engine.store.get<{ value: string }>(
            "SELECT value FROM meta WHERE key='recovery_cursor'",
          ),
        ).toEqual(cursor);
      }
      if (rig.engine.position(position.id).state === "WON") break;
    }
    expect(rig.engine.position(position.id).state).toBe("WON");
    expect(rig.engine.balance("taker")).toBe(1_250_000_000n);
    expect(rig.engine.audit().ok).toBe(true);
  } finally {
    rig.close();
  }
});

test("audit reconciles a valid ledger larger than the command codec budget", () => {
  const rig = new TestRig();
  try {
    const before = rig.engine.audit();
    const accounts = 34_000;
    // A trusted bulk fixture exercises the auditor, not API throughput or
    // bootstrap admission limits. Every account has exact external backing and
    // a journal entry. Serializing all these balances exceeds the input codec's
    // 100,000-node limit even though no individual command would be oversized.
    rig.engine.store.transaction(() => {
      for (let index = 0; index < accounts; index++) {
        fundFixture(rig.engine.store, `historical_account_${index}`, 1n);
      }
    });
    const report = rig.engine.audit();
    expect(report.ok).toBe(true);
    expect(report.totalFunded).toBe(before.totalFunded + BigInt(accounts));
    expect(report.journalEntries).toBe(before.journalEntries + accounts);
    expect(rig.engine.balance("historical_account_33999")).toBe(1n);
  } finally {
    rig.close();
  }
}, 15_000);

test("conserved release to wrong recipient fails provenance audit", () => {
  const rig = new TestRig();
  try {
    const request = rig.request();
    const quote = rig.quote(request);
    const beforeTotal = rig.engine.audit().totalFunded;
    // Privileged fault injection models a ledger bug below the public API.
    // State and totals are plausible; ownership of the returned collateral is wrong.
    rig.engine.store.transaction(() => {
      transfer(
        rig.engine.store,
        reserved(quote.id),
        available("attacker"),
        250_000_000n,
        "release_quote",
        quote.id,
      );
      rig.engine.store.run(
        "UPDATE quotes SET state='REJECTED' WHERE id=?",
        quote.id,
      );
      rig.engine.store.run(
        "UPDATE requests SET state='CANCELLED' WHERE id=?",
        request.id,
      );
    });
    expect(rig.engine.balance("attacker")).toBe(250_000_000n);
    const total = rig.engine
      .snapshot()
      .balances!.reduce((sum, row) => sum + (row.amount as bigint), 0n);
    expect(total).toBe(beforeTotal);
    expect(() => rig.engine.audit()).toThrow(/provenance/i);
  } finally {
    rig.close();
  }
});

test("audit rejects unbacked money with always-active checks", () => {
  const rig = new TestRig();
  try {
    rig.engine.store.run(
      "UPDATE balances SET amount=amount+1 WHERE account=?",
      available("taker"),
    );
    expect(() => rig.engine.audit()).toThrow();
  } finally {
    rig.close();
  }
});
