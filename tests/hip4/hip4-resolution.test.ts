import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/engine";
import {
  convertUnitsExact,
  hip4MarketId,
  parseDecimalUnits,
} from "../../src/integrations/hip4/index";
import {
  DEMO_TIMES,
  demoMarkets,
  fixtureBinding,
} from "../../examples/fixtures/hip4";
import {
  DomainError,
  ManualClock,
  decode,
  quotePrice,
} from "../../src/domain/index";
import { ResolutionService } from "../../src/resolution";
import type { ProposeHip4ResultArgs } from "../../src/resolution";
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

function observation(
  outcome = 1209,
  settleFraction = "1.0",
): ProposeHip4ResultArgs {
  const binding = fixtureBinding(outcome);
  return {
    network: binding.network,
    outcome,
    settleFraction,
    nameAndDescription: [binding.name, binding.description],
    sideNames: [binding.sideSpecs[0].name, binding.sideSpecs[1].name],
    evidence: "Trusted MOCK observation of the pinned outcome identity",
  };
}

describe("HIP-4 observation boundary", () => {
  let directory: string;
  let path: string;
  let clock: ManualClock;
  let engine: Engine;
  let sequence: number;
  const marketId = hip4MarketId(fixtureBinding(1209));

  function command(): string {
    return `hip4cmd${++sequence}`;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rfq-hip4-resolution-"));
    path = join(directory, "resolution.sqlite");
    clock = new ManualClock(DEMO_TIMES.requestedAt);
    engine = new Engine({ path, clock: clock.now });
    sequence = 0;
    engine.bootstrap(
      { taker: 1_000_000_000n, maker: 1_000_000_000n },
      demoMarkets(),
    );
  });

  afterEach(() => {
    engine.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function ticket(): Position {
    // Native USDC uses eight base-unit decimals in the captured metadata;
    // this local RFQ ledger has six and accepts only exact conversion.
    const stake = convertUnitsExact(parseDecimalUnits("100.000001", 8), 8, 6);
    const payout = convertUnitsExact(parseDecimalUnits("350.000009", 8), 8, 6);
    const request = engine.createRequest("taker", command(), {
      nonce: "hip4-ticket",
      legs: [
        { marketId, side: "YES" },
        { marketId: "hip4:mainnet:1210", side: "NO" },
      ],
      stake,
      responseDeadline: DEMO_TIMES.responseDeadline,
      acceptanceDeadline: DEMO_TIMES.acceptanceDeadline,
    });
    const quote = engine.submitQuote("maker", command(), {
      requestId: request.id,
      requestHash: request.termsHash,
      payout,
      priceE6: quotePrice(stake, payout),
      expiresAt: DEMO_TIMES.acceptanceDeadline,
    });
    if (!("maker" in quote)) throw new Error("Fixture quote was rejected");
    clock.set(DEMO_TIMES.responseDeadline);
    engine.select("keeper", command(), { requestId: request.id });
    const position = engine.accept("taker", command(), {
      requestId: request.id,
      quoteId: quote.id,
    });
    if (!("quoteId" in position))
      throw new Error("Fixture ticket was rejected");
    return position;
  }

  function rejectedWithoutMutation(
    code: string,
    args: ProposeHip4ResultArgs,
    actor = "oracle",
  ): void {
    const before = engine.snapshot();
    domainError(code, () => engine.proposeHip4Result(actor, command(), args));
    expect(engine.snapshot()).toEqual(before);
    expect(engine.audit().ok).toBe(true);
  }

  test("exact raw metadata proposes locally, preserves observation evidence and replays durably", () => {
    clock.set(DEMO_TIMES.resolveAfter);
    const args = observation();
    const id = command();
    const proposed = engine.proposeHip4Result("oracle", id, args);
    expect(proposed.state).toBe("PROPOSED");
    expect(proposed.proposedResult).toBe("YES");
    expect(proposed.finalResult).toBeNull();
    expect(proposed.challengeDeadline).toBe(DEMO_TIMES.challengeDeadline);
    expect(proposed.hip4).toEqual(fixtureBinding(1209));
    const event = engine.store.get<{ payloadJson: string }>(
      "SELECT payload_json FROM events WHERE aggregate_id = ? AND event_type = 'RESULT_PROPOSED'",
      marketId,
    );
    expect(
      decode<{ hip4Observation: ProposeHip4ResultArgs }>(event!.payloadJson)
        .hip4Observation,
    ).toEqual(args);
    clock.set(DEMO_TIMES.challengeDeadline);
    expect(
      engine.finalizeResult("keeper", command(), { marketId }).finalResult,
    ).toBe("YES");
    engine.close();
    engine = new Engine({ path, clock: clock.now });
    const before = engine.snapshot();
    expect(engine.proposeHip4Result("oracle", id, args)).toEqual(proposed);
    expect(engine.snapshot()).toEqual(before);
    domainError("IDEMPOTENCY_CONFLICT", () =>
      engine.proposeHip4Result("oracle", id, {
        ...args,
        settleFraction: "0.0",
      }),
    );
    expect(engine.market(marketId).finalResult).toBe("YES");
    expect(engine.audit().ok).toBe(true);
  });

  test("side zero maps to YES, side one to NO, with exact asymmetric micro-unit contributions", () => {
    const position = ticket();
    expect(position.stake).toBe(100_000_001n);
    expect(position.makerCollateral).toBe(250_000_008n);
    const before = engine.snapshot();
    domainError("PRECISION_LOSS", () =>
      convertUnitsExact(10_000_000_101n, 8, 6),
    );
    expect(engine.snapshot()).toEqual(before);
    clock.set(DEMO_TIMES.resolveAfter);
    engine.proposeHip4Result(
      "oracle",
      command(),
      observation(1209, "1.0000000000000000000000"),
    );
    engine.proposeHip4Result(
      "oracle",
      command(),
      observation(1210, "0.0000000000000000000000"),
    );
    clock.set(DEMO_TIMES.challengeDeadline);
    for (const id of [marketId, "hip4:mainnet:1210"])
      engine.finalizeResult("keeper", command(), { marketId: id });
    expect(
      engine.settle("keeper", command(), { positionId: position.id }).state,
    ).toBe("WON");
    expect(engine.balance("taker")).toBe(1_250_000_008n);
    expect(engine.balance("maker")).toBe(749_999_992n);
    expect(engine.audit().ok).toBe(true);
  });

  test("wrong raw names, descriptions or ordered side labels leave funded escrow and receipts unchanged", () => {
    ticket();
    clock.set(DEMO_TIMES.resolveAfter);
    const valid = observation();
    const variants: ProposeHip4ResultArgs[] = [
      {
        ...valid,
        nameAndDescription: [
          ` ${valid.nameAndDescription[0]}`,
          valid.nameAndDescription[1],
        ],
      },
      {
        ...valid,
        nameAndDescription: [
          valid.nameAndDescription[0],
          `${valid.nameAndDescription[1]} `,
        ],
      },
      { ...valid, sideNames: [valid.sideNames[1], valid.sideNames[0]] },
      { ...valid, sideNames: ["YES", "NO"] },
      { ...valid, sideNames: [valid.sideNames[0], "unknown"] },
      { ...valid, outcome: 1210 },
    ];
    for (const args of variants)
      rejectedWithoutMutation("HIP4_METADATA_MISMATCH", args);
    expect(engine.market(marketId).state).toBe("UNRESOLVED");
    expect(engine.balance("taker")).toBe(899_999_999n);
    expect(engine.balance("maker")).toBe(749_999_992n);
  });

  test.each(["", "  raw description with a trailing newline\n"])(
    "native observations preserve raw whitespace and the description %j",
    (description) => {
      const terms = demoMarkets()[0]!;
      const binding = terms.hip4!;
      binding.name = "  raw native name  ";
      binding.description = description;
      binding.sideSpecs = [{ name: " side zero " }, { name: " side one " }];
      terms.description = description || binding.name;
      engine.close();
      engine = new Engine({ clock: clock.now });
      engine.bootstrap({}, [terms]);
      clock.set(DEMO_TIMES.resolveAfter);
      const proposed = engine.proposeHip4Result("oracle", command(), {
        ...observation(),
        nameAndDescription: [binding.name, description],
        sideNames: [binding.sideSpecs[0].name, binding.sideSpecs[1].name],
      });
      expect(proposed.state).toBe("PROPOSED");
      expect(proposed.proposedResult).toBe("YES");
      expect(proposed.hip4).toEqual(binding);
      expect(proposed.description).toBe(terms.description);
      expect(engine.audit().ok).toBe(true);
    },
  );

  test("network and outcome IDs are part of lookup identity and never alias another market", () => {
    clock.set(DEMO_TIMES.resolveAfter);
    rejectedWithoutMutation("NOT_FOUND", {
      ...observation(),
      network: "testnet",
    });
    rejectedWithoutMutation("NOT_FOUND", { ...observation(), outcome: 9999 });
    for (const outcome of [-1, 1209.1, Number.MAX_SAFE_INTEGER, Number.NaN])
      rejectedWithoutMutation("INVALID_INPUT", { ...observation(), outcome });
  });

  test("a local market with a native-shaped ID still requires a frozen binding", () => {
    engine.close();
    engine = new Engine({ clock: clock.now });
    engine.bootstrap({}, [{ ...demoMarkets()[0]!, hip4: null }]);
    clock.set(DEMO_TIMES.resolveAfter);
    rejectedWithoutMutation("HIP4_BINDING_REQUIRED", observation());
  });

  test("interior fractions including values next to zero and one cannot become VOID or be rounded", () => {
    ticket();
    clock.set(DEMO_TIMES.resolveAfter);
    for (const value of [
      "0.5",
      "0.50",
      "0.99999999999999999999999999999999999999999999999999",
      "0.00000000000000000000000000000000000000000000000001",
    ])
      rejectedWithoutMutation(
        "FRACTIONAL_OUTCOME_UNSUPPORTED",
        observation(1209, value),
      );
    const market = engine.market(marketId);
    expect(market.state).toBe("UNRESOLVED");
    expect(market.finalResult).toBeNull();
    expect(market.proposedResult).toBeNull();
  });

  test("malformed fractions are rejected before proposal without numeric coercion", () => {
    clock.set(DEMO_TIMES.resolveAfter);
    for (const value of [
      "-0.1",
      "1.00000000000000000000000000001",
      "2",
      "NaN",
      "1e0",
      ".5",
      "01",
      " 1",
      "1.",
      "1".repeat(129),
    ])
      rejectedWithoutMutation("INVALID_INPUT", observation(1209, value));
    rejectedWithoutMutation("INVALID_INPUT", {
      ...observation(),
      settleFraction: 1 as unknown as string,
    });
  });

  test("native observations retain oracle authority and the local dispute and arbitration path", () => {
    ticket();
    clock.set(DEMO_TIMES.resolveAfter - 1);
    rejectedWithoutMutation("OUTSIDE_WINDOW", observation());
    clock.set(DEMO_TIMES.resolveAfter);
    rejectedWithoutMutation("FORBIDDEN", observation(), "maker");
    const proposed = engine.proposeHip4Result(
      "oracle",
      command(),
      observation(),
    );
    clock.set(DEMO_TIMES.challengeDeadline - 1);
    const disputed = engine.disputeResult("taker", command(), {
      marketId,
      reason: "Mock observation is contested",
    });
    expect(disputed.state).toBe("DISPUTED");
    expect(disputed.challengeDeadline).toBe(proposed.challengeDeadline);
    expect(disputed.fallbackAt).toBe(proposed.fallbackAt);
    expect(
      engine.arbitrateResult("arbiter", command(), {
        marketId,
        result: "NO",
        evidence: "Corrected local adjudication",
      }).finalResult,
    ).toBe("NO");
    rejectedWithoutMutation("INVALID_STATE", observation());
  });

  test("the latest proposal preserves both periods and delayed finalization retains the binary result", () => {
    clock.set(
      DEMO_TIMES.fallbackAt -
        DEMO_TIMES.disputePeriod -
        DEMO_TIMES.adjudicationPeriod,
    );
    const proposed = engine.proposeHip4Result(
      "oracle",
      command(),
      observation(),
    );
    expect(proposed.challengeDeadline).toBe(
      DEMO_TIMES.fallbackAt - DEMO_TIMES.adjudicationPeriod,
    );
    clock.set(DEMO_TIMES.fallbackAt + 1);
    expect(
      engine.finalizeResult("keeper", command(), { marketId }).finalResult,
    ).toBe("YES");
    expect(engine.audit().ok).toBe(true);
  });

  test("late native proposals cannot consume the adjudication buffer", () => {
    clock.set(
      DEMO_TIMES.fallbackAt -
        DEMO_TIMES.disputePeriod -
        DEMO_TIMES.adjudicationPeriod +
        1,
    );
    rejectedWithoutMutation("OUTSIDE_WINDOW", observation());
    clock.set(DEMO_TIMES.fallbackAt);
    rejectedWithoutMutation("OUTSIDE_WINDOW", observation());
    expect(
      engine.finalizeResult("keeper", command(), { marketId }).finalResult,
    ).toBe("VOID");
  });

  test("failure after proposal writes rolls back metadata, evidence, event and receipt; retry succeeds", () => {
    clock.set(DEMO_TIMES.resolveAfter);
    const before = engine.snapshot();
    engine.close();
    let fail = true;
    engine = new Engine({
      path,
      clock: clock.now,
      fault: (stage) => {
        if (fail && stage === "before_commit")
          throw new Error("simulated proposal failure");
      },
    });
    const id = command();
    expect(() => engine.proposeHip4Result("oracle", id, observation())).toThrow(
      "simulated proposal failure",
    );
    expect(engine.snapshot()).toEqual(before);
    fail = false;
    expect(engine.proposeHip4Result("oracle", id, observation()).state).toBe(
      "PROPOSED",
    );
    expect(engine.audit().ok).toBe(true);
  });

  test("bounded dense raw tuples reject accessors without invoking them or the command boundary", () => {
    let invoked = false;
    const service = new ResolutionService({
      command: () => {
        throw new Error("Invalid input reached command serialization");
      },
    } as unknown as ResolutionHost);
    const invalid: unknown[] = [
      { ...observation(), nameAndDescription: ["name"] },
      { ...observation(), nameAndDescription: ["name", "x".repeat(16_385)] },
      { ...observation(), sideNames: ["x".repeat(513), "NO"] },
      { ...observation(), sideNames: ["YES", "NO", "VOID"] },
      { ...observation(), evidence: "x".repeat(4097) },
      { ...observation(), network: "unknown" },
      { ...observation(), unexpected: true },
      { ...observation(), sideNames: new Array(2) },
    ];
    const sideNames = ["YES", "NO"];
    Object.defineProperty(sideNames, "0", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "YES";
      },
    });
    invalid.push({ ...observation(), sideNames });
    const args = observation();
    Object.defineProperty(args, "outcome", {
      enumerable: true,
      get: () => {
        invoked = true;
        return 1209;
      },
    });
    invalid.push(args);
    for (const value of invalid)
      domainError("INVALID_INPUT", () =>
        service.proposeHip4Result(
          "oracle",
          "invalid",
          value as ProposeHip4ResultArgs,
        ),
      );
    expect(invoked).toBe(false);
  });
});
