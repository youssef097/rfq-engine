import { describe, expect, test } from "bun:test";
import { Engine, type CreateRequestArgs } from "../../src/engine";
import { ManualClock, DomainError, quotePrice } from "../../src/domain/index";
import {
  demoMarkets,
  fixtureBinding,
  hip4Snapshot,
  DEMO_MARKET_IDS,
  DEMO_TIMES,
} from "../../examples/fixtures/hip4";
import {
  hip4MarketId,
  type Hip4Binding,
} from "../../src/integrations/hip4/index";
import type { MarketInput } from "../../src/domain/types";

const balances = { taker: 1_000_000_000n, maker: 2_000_000_000n };
const args = (ids: string[]): CreateRequestArgs => ({
  nonce: "hip4-ticket",
  stake: 100_000_000n,
  legs: ids.map((marketId) => ({ marketId, side: "YES" })),
  responseDeadline: DEMO_TIMES.responseDeadline,
  acceptanceDeadline: DEMO_TIMES.acceptanceDeadline,
});
function market(binding: Hip4Binding): MarketInput {
  return {
    ...demoMarkets()[0]!,
    id: hip4MarketId(binding),
    description: binding.description || binding.name,
    hip4: binding,
  };
}
function rejects(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("HIP-4 terms are execution commitments", () => {
  test("pinned public catalog and absolute UTC fixture fund one whole ticket", () => {
    const clock = new ManualClock(DEMO_TIMES.requestedAt);
    const engine = new Engine({ clock: clock.now });
    try {
      expect(hip4Snapshot.quoteAsset.token.weiDecimals).toBe(8);
      expect(Object.isFrozen(hip4Snapshot.outcomes[0]!.sideSpecs[0])).toBe(
        true,
      );
      expect(() => {
        hip4Snapshot.outcomes[0]!.name = "Substituted after checksum";
      }).toThrow();
      expect(fixtureBinding(1209).name).toBe("template:priceTouch");
      engine.bootstrap(balances, demoMarkets());
      const request = engine.createRequest(
        "taker",
        "request",
        args(DEMO_MARKET_IDS),
      );
      expect(request.legs.map((l) => l.marketId)).toEqual(DEMO_MARKET_IDS);
      const payout = 380_000_000n;
      const quote = engine.submitQuote("maker", "quote", {
        requestId: request.id,
        requestHash: request.termsHash,
        payout,
        priceE6: quotePrice(request.stake, payout),
        expiresAt: DEMO_TIMES.acceptanceDeadline,
      });
      expect(quote.state).toBe("LIVE");
      clock.set(DEMO_TIMES.responseDeadline);
      engine.select("keeper", "select", { requestId: request.id });
      const position = engine.accept("taker", "accept", {
        requestId: request.id,
        quoteId: quote.id,
      });
      expect(position.state).toBe("OPEN");
      expect(engine.market(DEMO_MARKET_IDS[1]).hip4?.outcome).toBe(1210);
      expect(engine.audit().positions).toBe(1);
    } finally {
      engine.close();
    }
  });

  test("a rejected scalar observation leaves the separately agreed local fallback available", () => {
    const clock = new ManualClock(DEMO_TIMES.requestedAt);
    const engine = new Engine({ clock: clock.now });
    try {
      engine.bootstrap(balances, demoMarkets());
      const request = engine.createRequest(
        "taker",
        "create",
        args([DEMO_MARKET_IDS[0]]),
      );
      const payout = 380_000_000n;
      const quote = engine.submitQuote("maker", "quote", {
        requestId: request.id,
        requestHash: request.termsHash,
        payout,
        priceE6: quotePrice(request.stake, payout),
        expiresAt: DEMO_TIMES.acceptanceDeadline,
      });
      clock.set(DEMO_TIMES.responseDeadline);
      engine.select("keeper", "select", { requestId: request.id });
      const position = engine.accept("taker", "accept", {
        requestId: request.id,
        quoteId: quote.id,
      });
      const binding = fixtureBinding(1209);
      clock.set(DEMO_TIMES.resolveAfter);
      const before = engine.snapshot();
      rejects(
        () =>
          engine.proposeHip4Result("oracle", "scalar", {
            network: binding.network,
            outcome: binding.outcome,
            settleFraction: "0.5",
            nameAndDescription: [binding.name, binding.description],
            sideNames: [binding.sideSpecs[0].name, binding.sideSpecs[1].name],
            evidence: "Simulated fractional observation",
          }),
        "FRACTIONAL_OUTCOME_UNSUPPORTED",
      );
      expect(engine.snapshot()).toEqual(before);
      expect(engine.market(DEMO_MARKET_IDS[0]).state).toBe("UNRESOLVED");
      clock.set(DEMO_TIMES.fallbackAt);
      engine.finalizeResult("keeper", "local-fallback", {
        marketId: DEMO_MARKET_IDS[0],
      });
      expect(
        engine.settle("keeper", "local-refund", { positionId: position.id })
          .state,
      ).toBe("VOID");
      expect(engine.balance("taker")).toBe(balances.taker);
      expect(engine.balance("maker")).toBe(balances.maker);
      expect(engine.audit().ok).toBe(true);
    } finally {
      engine.close();
    }
  });

  test("all imported identity, side and question metadata changes the immutable hash", () => {
    const base = fixtureBinding(1473);
    const variants = [
      base,
      { ...base, venue: "txyz" },
      { ...base, deployerFeeScale: "2" },
      {
        ...base,
        sideSpecs: [
          { name: "First" },
          { name: "Second" },
        ] as Hip4Binding["sideSpecs"],
      },
      {
        ...base,
        question: {
          ...base.question!,
          description: "Changed question specification",
        },
      },
    ];
    const hashes = variants.map((binding) => {
      const engine = new Engine({ clock: () => DEMO_TIMES.requestedAt });
      try {
        engine.bootstrap(balances, [market(binding)]);
        return engine.market(hip4MarketId(binding)).termsHash;
      } finally {
        engine.close();
      }
    });
    expect(new Set(hashes).size).toBe(variants.length);
  });

  test("aliases and substituted display descriptions cannot bypass bound identity", () => {
    for (const change of [
      { id: "friendly-alias" },
      { description: "This wording differs" },
    ]) {
      const engine = new Engine({ clock: () => DEMO_TIMES.requestedAt });
      try {
        rejects(
          () =>
            engine.bootstrap(balances, [{ ...demoMarkets()[0]!, ...change }]),
          "HIP4_TERMS_MISMATCH",
        );
      } finally {
        engine.close();
      }
    }
  });

  test("one question cannot contribute two selections, including opposite directions", () => {
    const engine = new Engine({ clock: () => DEMO_TIMES.requestedAt });
    try {
      const markets = [
        market(fixtureBinding(1473)),
        market(fixtureBinding(1474)),
      ];
      engine.bootstrap(balances, markets);
      const before = engine.snapshot();
      const request = args(markets.map((m) => m.id));
      rejects(
        () => engine.createRequest("taker", "same-question", request),
        "SAME_HIP4_QUESTION",
      );
      request.legs[1] = { ...request.legs[1]!, side: "NO" };
      rejects(
        () => engine.createRequest("taker", "opposite", request),
        "SAME_HIP4_QUESTION",
      );
      expect(engine.snapshot()).toEqual(before);
      expect(engine.audit().ok).toBe(true);
    } finally {
      engine.close();
    }
  });

  test("a ticket cannot mix Hyperliquid networks or bypass metadata with an unbound leg", () => {
    const main = fixtureBinding(1209);
    const testnet: Hip4Binding = {
      ...main,
      network: "testnet",
      source: {
        ...main.source,
        endpoint: "https://api.hyperliquid-testnet.xyz/info",
      },
    };
    for (const extra of [
      market(testnet),
      { ...demoMarkets()[1]!, id: "unbound", hip4: null },
    ]) {
      const engine = new Engine({ clock: () => DEMO_TIMES.requestedAt });
      try {
        engine.bootstrap(balances, [market(main), extra]);
        rejects(
          () =>
            engine.createRequest(
              "taker",
              "mixed",
              args([hip4MarketId(main), extra.id]),
            ),
          "MIXED_MARKET_DOMAIN",
        );
        expect(engine.audit().requests).toBe(0);
      } finally {
        engine.close();
      }
    }
  });

  test("a known settled question member is ineligible even with a future local cutoff", () => {
    const binding = fixtureBinding(1473);
    binding.question!.settledNamedOutcomes = [1473];
    const engine = new Engine({ clock: () => DEMO_TIMES.requestedAt });
    try {
      engine.bootstrap(balances, [market(binding)]);
      rejects(
        () =>
          engine.createRequest(
            "taker",
            "settled",
            args([hip4MarketId(binding)]),
          ),
        "INVALID_LEG",
      );
      expect(engine.audit().requests).toBe(0);
    } finally {
      engine.close();
    }
  });

  test("caller mutation cannot alter stored source metadata or a ticket commitment", () => {
    const markets = demoMarkets();
    const engine = new Engine({ clock: () => DEMO_TIMES.requestedAt });
    try {
      engine.bootstrap(balances, markets);
      const request = engine.createRequest(
        "taker",
        "create",
        args(DEMO_MARKET_IDS),
      );
      const original = engine.market(DEMO_MARKET_IDS[0]);
      markets[0]!.hip4!.sideSpecs[0].name = "Substituted label";
      markets[0]!.hip4!.source.sha256 = "0".repeat(64);
      expect(engine.market(DEMO_MARKET_IDS[0])).toEqual(original);
      expect(engine.request(request.id).termsHash).toBe(request.termsHash);
      expect(() =>
        engine.store.run(
          "UPDATE markets SET hip4_json=? WHERE id=?",
          '["null"]',
          original.id,
        ),
      ).toThrow();
      expect(engine.audit().ok).toBe(true);
    } finally {
      engine.close();
    }
  });
});
