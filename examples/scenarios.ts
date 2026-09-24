/** Eleven asserted request, execution, and resolution scenarios. */
import assert from "node:assert/strict";
import { DomainError } from "../src/domain/index";
import type { AuditReport, Outcome } from "../src/domain/types";
import { DEMO_MARKET_IDS, DEMO_TIMES } from "./fixtures/hip4";
import { ACTORS, metadataFor, units } from "./metadata";
import { Scenario, type TraceStep } from "./scenario";

export const SCENARIOS = [
  "win",
  "single",
  "loss",
  "void",
  "no_quotes",
  "expiry",
  "insufficient_funds",
  "invalid_leg",
  "rollback",
  "dispute",
  "delayed",
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface ScenarioTrace {
  scenario: ScenarioName;
  metadata: ReturnType<typeof metadataFor>;
  steps: TraceStep[];
  finalAudit: AuditReport;
}

export function runScenario(name: ScenarioName, path: string): ScenarioTrace {
  const scenario = new Scenario(
    path,
    name === "insufficient_funds" ? units("50") : units("1000"),
  );
  try {
    scenario.create(name === "single" ? 1 : 3);
    if (name === "no_quotes") {
      assert.equal(scenario.select().state, "REJECTED");
      scenario.assertUnfilledReleased();
      scenario.capture("no quote: request rejected with no locked money");
    } else {
      scenario.quote(
        name === "expiry"
          ? DEMO_TIMES.shortQuoteExpiry
          : DEMO_TIMES.acceptanceDeadline,
      );
      const selected = scenario.select();
      const best = scenario.quotes[1];
      assert(best);
      assert.equal(selected.selectedQuoteId, best.id);
      if (name === "expiry") {
        scenario.clock.set(DEMO_TIMES.shortQuoteExpiry);
        assert.equal(scenario.accept().state, "EXPIRED");
        scenario.assertUnfilledReleased();
        scenario.capture("accept at exact expiry: all reservations released");
      } else if (name === "insufficient_funds") {
        const rejected = scenario.accept();
        assert("reason" in rejected);
        assert.equal(rejected.reason, "INSUFFICIENT_TAKER_FUNDS");
        scenario.assertUnfilledReleased();
        scenario.capture(
          "unfunded taker: no position and every maker refunded",
        );
      } else if (name === "invalid_leg") {
        scenario.engine.haltMarket(ACTORS.operator, "halt-leg-2", {
          marketId: DEMO_MARKET_IDS[1],
          reason:
            "SIMULATION: operator halts new RFQs for the BTC binary-price observation",
        });
        const rejected = scenario.accept();
        assert("reason" in rejected);
        assert.equal(rejected.reason, "INVALID_LEG");
        scenario.assertUnfilledReleased();
        scenario.capture("leg 2 unavailable: the entire ticket is rejected");
      } else {
        if (name === "rollback") {
          const before = scenario.engine.snapshot();
          scenario.faultStage = "after_leg:0";
          assert.throws(
            () => scenario.accept(),
            /simulated failure before commit at after_leg:0/,
          );
          assert.deepEqual(scenario.engine.snapshot(), before);
          scenario.faultStage = null;
          scenario.capture(
            "failure between leg writes: full rollback, offer remains backed",
          );
        }
        const position = scenario.accept();
        assert(
          "quoteId" in position,
          "Successful acceptance must create a whole-ticket position",
        );
        assert.equal(position.state, "OPEN");
        assert.equal(position.payout, units("380"));
        assert.equal(scenario.engine.balance(ACTORS.makerA), units("2000"));
        assert.equal(scenario.engine.balance(ACTORS.makerC), units("2000"));
        scenario.capture("accepted: one pot funded; competing makers released");
        let expected: "WON" | "LOST" | "VOID";
        if (name === "dispute") {
          scenario.clock.set(DEMO_TIMES.resolveAfter);
          for (const marketId of DEMO_MARKET_IDS) {
            scenario.propose(marketId, "YES");
          }
          scenario.engine.disputeResult(ACTORS.makerB, "challenge", {
            marketId: DEMO_MARKET_IDS[1],
            reason:
              "SIMULATION: disputed BTC terminal mark at the captured binary-price observation time",
          });
          assert.throws(
            () =>
              scenario.engine.settle(ACTORS.keeper, "too-early", {
                positionId: position.id,
              }),
            (error: unknown) =>
              error instanceof DomainError && error.code === "NOT_FINAL",
          );
          scenario.capture(
            "disputed outcome: premature settlement rejected; escrow remains locked",
          );
          scenario.engine.arbitrateResult(ACTORS.arbiter, "ruling", {
            marketId: DEMO_MARKET_IDS[1],
            result: "NO",
            evidence:
              "SIMULATION: BTC touched the target earlier but ended below the binary threshold at expiry; immutable metadata retained",
          });
          scenario.clock.set(DEMO_TIMES.challengeDeadline);
          for (const marketId of [DEMO_MARKET_IDS[0], DEMO_MARKET_IDS[2]]) {
            scenario.engine.finalizeResult(
              ACTORS.keeper,
              `finalize-${marketId}`,
              {
                marketId,
              },
            );
          }
          expected = "LOST";
        } else if (name === "delayed") {
          scenario.clock.set(DEMO_TIMES.fallbackAt);
          let hasMore = true;
          let batch = 0;
          while (hasMore) {
            assert(batch < 10, "Bounded recovery must make progress");
            const recovered = scenario.engine.recover(
              ACTORS.keeper,
              `recover-${batch++}`,
              { limit: 2 },
            );
            hasMore = recovered.hasMore;
            scenario.capture(
              "bounded recovery advances missing outcomes and settlement",
            );
          }
          expected = "VOID";
        } else {
          const outcomes: Record<string, Outcome> = {};
          for (const leg of position.legs) outcomes[leg.marketId] = "YES";
          if (name === "loss") {
            outcomes[DEMO_MARKET_IDS[0]] = "VOID";
            outcomes[DEMO_MARKET_IDS[1]] = "NO";
          }
          if (name === "void") outcomes[DEMO_MARKET_IDS[1]] = "VOID";
          scenario.resolve(outcomes);
          expected =
            name === "loss" ? "LOST" : name === "void" ? "VOID" : "WON";
        }
        const settled = scenario.engine.settle(ACTORS.keeper, "settle", {
          positionId: position.id,
        });
        assert.equal(settled.state, expected);
        const journalBefore = scenario.engine.audit().journalEntries;
        assert.deepEqual(
          scenario.engine.settle(ACTORS.keeper, "settle-again", {
            positionId: position.id,
          }),
          settled,
        );
        assert.equal(scenario.engine.audit().journalEntries, journalBefore);
        scenario.capture(
          `${expected}: one combined settlement; retry produces no extra transfer`,
        );
      }
    }
    return {
      scenario: name,
      metadata: metadataFor(
        scenario.request?.legs.map((leg) => leg.marketId) ?? [],
      ),
      steps: scenario.steps,
      finalAudit: scenario.engine.audit(),
    };
  } finally {
    scenario.engine.close();
  }
}
