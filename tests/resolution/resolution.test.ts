import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/engine";
import { DomainError, ManualClock, quotePrice } from "../../src/domain/index";
import {
  proposeResult,
  disputeResult,
  finalizeResult,
  arbitrateResult,
  settle,
} from "../../src/resolution";
import type { ResolutionResult } from "../../src/resolution";
import { balance, escrow } from "../../src/storage/index";
import type { Position } from "../../src/domain/types";
import type { ResolutionHost } from "../../src/resolution";

function domainError(code: string, action: () => unknown): void {
  try {
    action();
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected DomainError(${code})`);
}

describe("whole-ticket resolution", () => {
  let directory: string;
  let path: string;
  let clock: ManualClock;
  let engine: Engine;
  let commandNumber: number;

  function command(): string {
    commandNumber += 1;
    return `cmd${commandNumber}`;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rfq-resolution-"));
    path = join(directory, "resolution.sqlite");
    clock = new ManualClock(1000);
    engine = new Engine({ path, clock: clock.now });
    commandNumber = 0;
    engine.bootstrap(
      { taker: 1_000_000_000n, maker: 1_000_000_000n },
      Array.from({ length: 3 }, (_, index) => ({
        id: `market${index}`,
        description: `Binary event ${index}`,
        tradingClosesAt: 10000,
        resolveAfter: 11000,
        disputePeriod: 1000,
        adjudicationPeriod: 1000,
        fallbackAt: 20000,
        oracle: "oracle",
        arbiter: "arbiter",
      })),
    );
  });

  afterEach(() => {
    engine.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function ticket(
    sides: ("YES" | "NO")[] = ["YES", "YES"],
    stake = 100_000_000n,
    payout = 350_000_000n,
  ): Position {
    const request = engine.createRequest("taker", command(), {
      nonce: "ticket1",
      legs: sides.map((side, index) => ({ marketId: `market${index}`, side })),
      stake,
      responseDeadline: 2000,
      acceptanceDeadline: 5000,
    });
    const quote = engine.submitQuote("maker", command(), {
      requestId: request.id,
      requestHash: request.termsHash,
      payout,
      priceE6: quotePrice(stake, payout),
      expiresAt: 5000,
    });
    if (!("maker" in quote))
      throw new Error("Fixture quote unexpectedly rejected");
    clock.set(2000);
    engine.select("keeper", command(), { requestId: request.id });
    const position = engine.accept("taker", command(), {
      requestId: request.id,
      quoteId: quote.id,
    });
    if (!("quoteId" in position))
      throw new Error("Fixture ticket unexpectedly rejected");
    return position;
  }

  function propose(index: number, result: ResolutionResult) {
    return engine.proposeResult("oracle", command(), {
      marketId: `market${index}`,
      result,
      evidence: "observed source",
    });
  }

  function finalize(index: number) {
    return engine.finalizeResult("keeper", command(), {
      marketId: `market${index}`,
    });
  }

  test("all-final guard keeps escrow locked even after a known loss", () => {
    const position = ticket();
    clock.set(11000);
    propose(0, "NO");
    clock.set(12000);
    finalize(0);
    domainError("NOT_FINAL", () =>
      engine.settle("keeper", command(), { positionId: position.id }),
    );
    expect(engine.position(position.id).state).toBe("OPEN");
    expect(engine.balance("maker")).toBe(750_000_000n);
    clock.set(20000);
    finalize(1);
    expect(
      engine.settle("keeper", command(), { positionId: position.id }).state,
    ).toBe("LOST");
    expect(engine.balance("taker")).toBe(900_000_000n);
    expect(engine.balance("maker")).toBe(1_100_000_000n);
    expect(engine.audit().ok).toBe(true);
  });

  test("loss dominates VOID and winning legs", () => {
    const position = ticket(["YES", "YES", "YES"]);
    clock.set(11000);
    propose(0, "VOID");
    propose(1, "YES");
    propose(2, "NO");
    clock.set(12000);
    for (let index = 0; index < 3; index++) finalize(index);
    expect(
      engine.settle("anyone", command(), { positionId: position.id }).state,
    ).toBe("LOST");
    expect(engine.balance("maker")).toBe(1_100_000_000n);
    expect(engine.audit().ok).toBe(true);
  });

  test("NO side can win and repeated settlement never pays twice", () => {
    const position = ticket(["NO", "YES"]);
    clock.set(11000);
    propose(0, "NO");
    propose(1, "YES");
    clock.set(12000);
    finalize(0);
    finalize(1);
    const id = command();
    const first = engine.settle("keeper", id, { positionId: position.id });
    expect(first.state).toBe("WON");
    expect(engine.settle("keeper", id, { positionId: position.id })).toEqual(
      first,
    );
    expect(
      engine.settle("another", command(), { positionId: position.id }),
    ).toEqual(first);
    expect(engine.balance("taker")).toBe(1_250_000_000n);
    expect(engine.balance("maker")).toBe(750_000_000n);
    expect(engine.audit().ok).toBe(true);
  });

  test("VOID refunds each exact bigint contribution without rounding", () => {
    const position = ticket(["YES", "YES"], 100_000_001n, 350_000_009n);
    expect(position.makerCollateral).toBe(250_000_008n);
    clock.set(11000);
    propose(0, "YES");
    propose(1, "VOID");
    clock.set(12000);
    finalize(0);
    finalize(1);
    expect(
      engine.settle("keeper", command(), { positionId: position.id }).state,
    ).toBe("VOID");
    expect(engine.balance("taker")).toBe(1_000_000_000n);
    expect(engine.balance("maker")).toBe(1_000_000_000n);
    expect(engine.audit().ok).toBe(true);
  });

  test.each([
    ["YES", "WON", 1_250_000_000n, 750_000_000n],
    ["NO", "LOST", 900_000_000n, 1_100_000_000n],
    ["VOID", "VOID", 1_000_000_000n, 1_000_000_000n],
  ] as const)(
    "failure after a %s transfer rolls back every write and the same command can retry",
    (result, state, takerBalance, makerBalance) => {
      const position = ticket(["YES"]);
      clock.set(11000);
      propose(0, result);
      clock.set(12000);
      finalize(0);
      const before = engine.snapshot();
      engine.close();
      engine = new Engine({
        path,
        clock: clock.now,
        fault: (stage: string) => {
          if (stage === "after_settlement_transfer")
            throw new Error("simulated failure after settlement transfer");
        },
      });
      const id = command();
      expect(() =>
        engine.settle("keeper", id, { positionId: position.id }),
      ).toThrow("after settlement transfer");
      expect(engine.snapshot()).toEqual(before);
      expect(engine.audit().ok).toBe(true);
      engine.close();
      engine = new Engine({ path, clock: clock.now });
      expect(
        engine.settle("keeper", id, { positionId: position.id }).state,
      ).toBe(state);
      expect(engine.request(position.requestId).state).toBe("SETTLED");
      expect(engine.balance("taker")).toBe(takerBalance);
      expect(engine.balance("maker")).toBe(makerBalance);
      expect(balance(engine.store, escrow(position.id))).toBe(0n);
      const committed = engine.snapshot();
      engine.settle("keeper", id, { positionId: position.id });
      expect(engine.snapshot()).toEqual(committed);
      expect(engine.audit().ok).toBe(true);
    },
  );

  test("a funded counterparty may challenge only markets included in its position", () => {
    ticket(["YES"]);
    clock.set(11000);
    propose(0, "YES");
    propose(1, "YES");
    const before = engine.snapshot();
    for (const actor of ["taker", "maker"]) {
      domainError("FORBIDDEN", () =>
        engine.disputeResult(actor, command(), {
          marketId: "market1",
          reason: "An unrelated position grants no challenge authority",
        }),
      );
      expect(engine.snapshot()).toEqual(before);
    }
    expect(
      engine.disputeResult("maker", command(), {
        marketId: "market0",
        reason: "This market is a funded leg",
      }).state,
    ).toBe("DISPUTED");
    expect(engine.market("market1").state).toBe("PROPOSED");
    expect(engine.audit().ok).toBe(true);
  });

  test("arbitration can finish before the challenge deadline while all collateral stays escrowed", () => {
    const position = ticket(["YES"]);
    const funded = engine.snapshot();
    clock.set(11000);
    const proposed = propose(0, "YES");
    engine.disputeResult("taker", command(), {
      marketId: "market0",
      reason: "Evidence resolves an ambiguity immediately",
    });
    expect(clock.now()).toBeLessThan(proposed.challengeDeadline!);
    const final = engine.arbitrateResult("arbiter", command(), {
      marketId: "market0",
      result: "VOID",
      evidence: "The adjudication period reserves time; it is not a wait",
    });
    expect(final.state).toBe("FINAL");
    expect(final.finalResult).toBe("VOID");
    expect(final.challengeDeadline).toBe(proposed.challengeDeadline);
    expect(final.fallbackAt).toBe(proposed.fallbackAt);
    expect(engine.position(position.id)).toEqual(position);
    expect(engine.request(position.requestId).state).toBe("FILLED");
    expect(engine.snapshot().balances).toEqual(funded.balances!);
    expect(engine.snapshot().journal).toEqual(funded.journal!);
    expect(balance(engine.store, escrow(position.id))).toBe(position.payout);
    expect(
      engine.settle("keeper", command(), { positionId: position.id }).state,
    ).toBe("VOID");
    expect(engine.audit().ok).toBe(true);
  });

  test("proposal and dispute authority are enforced at exact challenge boundary", () => {
    ticket(["YES"]);
    clock.set(10999);
    domainError("OUTSIDE_WINDOW", () => propose(0, "YES"));
    clock.set(11000);
    domainError("FORBIDDEN", () =>
      engine.proposeResult("maker", command(), {
        marketId: "market0",
        result: "YES",
        evidence: "untrusted",
      }),
    );
    expect(propose(0, "YES").challengeDeadline).toBe(12000);
    domainError("FORBIDDEN", () =>
      engine.disputeResult("outsider", command(), {
        marketId: "market0",
        reason: "no economic position",
      }),
    );
    clock.set(11999);
    domainError("NOT_READY", () => finalize(0));
    clock.set(12000);
    domainError("OUTSIDE_WINDOW", () =>
      engine.disputeResult("taker", command(), {
        marketId: "market0",
        reason: "too late",
      }),
    );
    expect(finalize(0).finalResult).toBe("YES");
  });

  test("dispute preserves deadlines, requires arbiter, and final rulings are immutable", () => {
    ticket(["YES"]);
    clock.set(11000);
    const proposed = propose(0, "YES");
    clock.set(11999);
    const disputed = engine.disputeResult("maker", command(), {
      marketId: "market0",
      reason: "source discrepancy",
    });
    expect(disputed.challengeDeadline).toBe(proposed.challengeDeadline);
    expect(disputed.fallbackAt).toBe(proposed.fallbackAt);
    clock.set(12000);
    domainError("NOT_READY", () => finalize(0));
    domainError("FORBIDDEN", () =>
      engine.arbitrateResult("oracle", command(), {
        marketId: "market0",
        result: "NO",
        evidence: "oracle is not arbiter",
      }),
    );
    const final = engine.arbitrateResult("arbiter", command(), {
      marketId: "market0",
      result: "NO",
      evidence: "binding review",
    });
    expect(final.finalResult).toBe("NO");
    domainError("ALREADY_FINAL", () =>
      engine.arbitrateResult("arbiter", command(), {
        marketId: "market0",
        result: "YES",
        evidence: "cannot replace final ruling",
      }),
    );
    expect(
      engine.arbitrateResult("arbiter", command(), {
        marketId: "market0",
        result: "NO",
        evidence: "new evidence ignored",
      }),
    ).toEqual(final);
  });

  test("hard fallback closes disputes at the exact deadline", () => {
    const position = ticket(["YES"]);
    clock.set(18000);
    expect(propose(0, "YES").challengeDeadline).toBe(19000);
    engine.disputeResult("taker", command(), {
      marketId: "market0",
      reason: "ambiguous result",
    });
    clock.set(20000);
    domainError("OUTSIDE_WINDOW", () =>
      engine.arbitrateResult("arbiter", command(), {
        marketId: "market0",
        result: "YES",
        evidence: "missed hard deadline",
      }),
    );
    expect(finalize(0).finalResult).toBe("VOID");
    expect(
      engine.settle("keeper", command(), { positionId: position.id }).state,
    ).toBe("VOID");
  });

  test("last valid challenge preserves a full adjudication buffer and the winner's payout", () => {
    const position = ticket(["YES"]);
    clock.set(18000);
    const proposed = propose(0, "YES");
    expect(proposed.challengeDeadline).toBe(19000);
    expect(proposed.adjudicationPeriod).toBe(1000);
    expect(proposed.fallbackAt).toBe(20000);
    clock.set(18999);
    const disputed = engine.disputeResult("maker", command(), {
      marketId: "market0",
      reason: "Late challenge by the maker who would lose on YES",
    });
    expect(disputed.challengeDeadline).toBe(proposed.challengeDeadline);
    expect(disputed.fallbackAt).toBe(proposed.fallbackAt);
    expect(disputed.fallbackAt - clock.now()).toBeGreaterThanOrEqual(
      disputed.adjudicationPeriod,
    );
    expect(engine.position(position.id).state).toBe("OPEN");
    expect(balance(engine.store, escrow(position.id))).toBe(350_000_000n);
    expect(engine.audit().ok).toBe(true);
    clock.set(19999);
    expect(
      engine.arbitrateResult("arbiter", command(), {
        marketId: "market0",
        result: "YES",
        evidence: "Review completes during the reserved adjudication interval",
      }).finalResult,
    ).toBe("YES");
    clock.set(20000);
    expect(finalize(0).finalResult).toBe("YES");
    expect(
      engine.settle("keeper", command(), { positionId: position.id }).state,
    ).toBe("WON");
    expect(engine.balance("taker")).toBe(1_250_000_000n);
    expect(engine.balance("maker")).toBe(750_000_000n);
    expect(balance(engine.store, escrow(position.id))).toBe(0n);
    expect(engine.audit().ok).toBe(true);
  });

  test("unfinalized unchallenged proposal keeps its outcome at hard fallback", () => {
    clock.set(11000);
    propose(0, "YES");
    clock.set(20000);
    const final = finalize(0);
    expect(final.finalResult).toBe("YES");
    expect(finalize(0)).toEqual(final);
  });

  test("late keeper recovers mature result and pays the correct winner", () => {
    const position = ticket(["YES"]);
    clock.set(11000);
    propose(0, "YES");
    clock.set(30000);
    const recovered = engine.recover("keeper", command());
    expect(recovered.positions).toBe(1);
    expect(engine.market("market0").finalResult).toBe("YES");
    expect(engine.position(position.id).state).toBe("WON");
    expect(engine.balance("taker")).toBe(1_250_000_000n);
    expect(engine.balance("maker")).toBe(750_000_000n);
    expect(engine.audit().ok).toBe(true);
  });

  test("last full proposal window permits outcome at exact challenge cutoff", () => {
    const position = ticket(["YES"]);
    clock.set(18000);
    expect(propose(0, "YES").challengeDeadline).toBe(19000);
    clock.set(19000);
    domainError("OUTSIDE_WINDOW", () =>
      engine.disputeResult("maker", command(), {
        marketId: "market0",
        reason: "too late at exact deadline",
      }),
    );
    expect(finalize(0).finalResult).toBe("YES");
    expect(
      engine.settle("keeper", command(), { positionId: position.id }).state,
    ).toBe("WON");
  });

  test("proposal one millisecond too late cannot consume the adjudication buffer", () => {
    const position = ticket(["YES"]);
    clock.set(18001);
    const before = engine.snapshot();
    domainError("OUTSIDE_WINDOW", () => propose(0, "YES"));
    expect(engine.snapshot()).toEqual(before);
    expect(engine.market("market0").state).toBe("UNRESOLVED");
    clock.set(20000);
    expect(finalize(0).finalResult).toBe("VOID");
    expect(
      engine.settle("keeper", command(), { positionId: position.id }).state,
    ).toBe("VOID");
    expect(engine.balance("taker")).toBe(1_000_000_000n);
    expect(engine.balance("maker")).toBe(1_000_000_000n);
    expect(engine.audit().ok).toBe(true);
  });

  test("proposal window excludes hard fallback", () => {
    clock.set(20000);
    domainError("OUTSIDE_WINDOW", () => propose(0, "YES"));
    expect(finalize(0).finalResult).toBe("VOID");
  });

  test("malformed inputs are rejected before host command and payload hashing", () => {
    // Deliberately incomplete host proves invalid input never reaches a command,
    // database read, or serializer. The cast exists solely for this test seam.
    const host = {
      command: () => {
        throw new Error("must validate before command");
      },
    } as unknown as ResolutionHost;
    const accessorArgs = {
      get marketId(): string {
        throw new Error("accessor must never be invoked");
      },
      result: "YES" as const,
      evidence: "source",
    };
    const cases: (() => unknown)[] = [
      () => proposeResult(host, "actor", command(), null as never),
      () => proposeResult(host, "actor", command(), accessorArgs),
      () =>
        proposeResult(host, "actor", command(), {
          marketId: "x".repeat(65),
          result: "YES",
          evidence: "source",
        }),
      () =>
        proposeResult(host, "actor", command(), {
          marketId: "market0",
          result: {} as never,
          evidence: "source",
        }),
      () =>
        proposeResult(host, "actor", command(), {
          marketId: "market0",
          result: "YES",
          evidence: "x".repeat(4097),
        }),
      () =>
        disputeResult(host, "actor", command(), {
          marketId: "market0",
          reason: {} as never,
        }),
      () => finalizeResult(host, "actor", command(), { marketId: {} as never }),
      () =>
        finalizeResult(host, "actor", command(), {
          marketId: "market0",
          unexpected: true,
        } as never),
      () =>
        arbitrateResult(host, "actor", command(), {
          marketId: "market0",
          result: {} as never,
          evidence: "source",
        }),
      () =>
        arbitrateResult(host, "actor", command(), {
          marketId: "market0",
          result: "YES",
          evidence: {} as never,
        }),
      () => settle(host, "actor", command(), { positionId: {} as never }),
    ];
    const before = engine.snapshot();
    for (const run of cases) domainError("INVALID_INPUT", run);
    expect(engine.snapshot()).toEqual(before);
  });
});
