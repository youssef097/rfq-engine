/** One isolated database, deterministic clock, and asserted demo operations. */
import assert from "node:assert/strict";
import { Engine } from "../src/engine";
import { ManualClock, quotePrice } from "../src/domain/index";
import type {
  AuditReport,
  Outcome,
  Position,
  Quote,
  RequestRecord,
} from "../src/domain/types";
import { DEMO_MARKET_IDS, DEMO_TIMES, demoMarkets } from "./fixtures/hip4";
import { ACTORS, OFFERS, units } from "./metadata";

export interface TraceStep {
  step: string;
  atUtc: string;
  requestState: string | null;
  availableMicroUnits: Record<string, bigint>;
  audit: AuditReport;
}
export class Scenario {
  readonly clock = new ManualClock(DEMO_TIMES.requestedAt);
  readonly engine: Engine;
  readonly steps: TraceStep[] = [];
  readonly quotes: Quote[] = [];
  request: RequestRecord | null = null;
  faultStage: string | null = null;

  constructor(
    path: string,
    readonly takerFunds = units("1000"),
  ) {
    this.engine = new Engine({
      path,
      clock: this.clock.now,
      fault: (stage: string) => {
        if (stage === this.faultStage)
          throw new Error(`simulated failure before commit at ${stage}`);
      },
    });
    this.engine.bootstrap(
      {
        [ACTORS.taker]: takerFunds,
        [ACTORS.makerA]: units("2000"),
        [ACTORS.makerB]: units("2000"),
        [ACTORS.makerC]: units("2000"),
      },
      demoMarkets(ACTORS.oracle, ACTORS.arbiter),
      ACTORS.operator,
    );
  }

  private needRequest(): RequestRecord {
    assert(this.request, "Scenario must create a request first");
    return this.request;
  }

  capture(label: string): void {
    this.steps.push({
      step: label,
      atUtc: new Date(this.clock.now()).toISOString(),
      requestState: this.request
        ? this.engine.request(this.request.id).state
        : null,
      availableMicroUnits: Object.fromEntries(
        [ACTORS.taker, ACTORS.makerA, ACTORS.makerB, ACTORS.makerC].map(
          (actor) => [actor, this.engine.balance(actor)],
        ),
      ),
      audit: this.engine.audit(),
    });
  }

  create(legs = 3): RequestRecord {
    this.request = this.engine.createRequest(ACTORS.taker, "create", {
      nonce: "ticket-1",
      stake: units("100"),
      legs: DEMO_MARKET_IDS.slice(0, legs).map((marketId) => ({
        marketId,
        side: "YES",
      })),
      responseDeadline: DEMO_TIMES.responseDeadline,
      acceptanceDeadline: DEMO_TIMES.acceptanceDeadline,
    });
    this.capture("request created");
    return this.needRequest();
  }

  quote(expiry = DEMO_TIMES.acceptanceDeadline): void {
    const request = this.needRequest();
    for (const { maker, payout } of OFFERS) {
      const quote = this.engine.submitQuote(maker, `quote-${maker}`, {
        requestId: request.id,
        requestHash: request.termsHash,
        payout,
        priceE6: quotePrice(request.stake, payout),
        expiresAt: expiry,
      });
      assert("maker" in quote, "Fixture quote must be accepted");
      this.quotes.push(quote);
    }
    this.capture("three whole-ticket quotes fully reserved");
  }

  select(): RequestRecord {
    this.clock.set(DEMO_TIMES.responseDeadline);
    const selected = this.engine.select(ACTORS.keeper, "select", {
      requestId: this.needRequest().id,
    });
    this.capture(
      selected.state === "OFFERED"
        ? "collection closed; exact highest payout selected"
        : "collection closed; no eligible quote",
    );
    return selected;
  }

  accept(): Position | RequestRecord {
    const selected = this.engine.request(this.needRequest().id);
    assert(
      selected.selectedQuoteId,
      "Scenario must select an exact quote before accepting",
    );
    return this.engine.accept(ACTORS.taker, "accept", {
      requestId: selected.id,
      quoteId: selected.selectedQuoteId,
    });
  }

  propose(marketId: string, result: Outcome): void {
    const binding = this.engine.market(marketId).hip4;
    assert(binding, "Demo proposal requires an immutable HIP-4 binding");
    if (result === "VOID") {
      this.engine.proposeResult(ACTORS.oracle, `propose-${marketId}`, {
        marketId,
        result,
        evidence:
          "SIMULATION: unresolved price observation invokes the local RFQ VOID/refund policy; no native settleFraction is asserted",
      });
      return;
    }
    this.engine.proposeHip4Result(ACTORS.oracle, `propose-${marketId}`, {
      network: binding.network,
      outcome: binding.outcome,
      settleFraction: result === "YES" ? "1" : "0",
      nameAndDescription: [binding.name, binding.description],
      sideNames: [binding.sideSpecs[0].name, binding.sideSpecs[1].name],
      evidence:
        "SIMULATION: fabricated binary price/touch observation for pinned identity; no live price feed or final venue result was read",
    });
  }

  resolve(outcomes: Record<string, Outcome>): void {
    this.clock.set(DEMO_TIMES.resolveAfter);
    for (const [marketId, result] of Object.entries(outcomes)) {
      this.propose(marketId, result);
    }
    this.clock.set(DEMO_TIMES.challengeDeadline);
    for (const marketId of Object.keys(outcomes)) {
      this.engine.finalizeResult(ACTORS.keeper, `finalize-${marketId}`, {
        marketId,
      });
    }
  }

  assertUnfilledReleased(): void {
    assert.equal(this.engine.audit().positions, 0);
    assert.equal(this.engine.balance(ACTORS.taker), this.takerFunds);
    for (const maker of [ACTORS.makerA, ACTORS.makerB, ACTORS.makerC]) {
      assert.equal(this.engine.balance(maker), units("2000"));
    }
  }
}
