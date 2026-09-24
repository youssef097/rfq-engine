import { expect, test } from "bun:test";
import { Engine } from "../../src/engine";
import { checkMarketTerms } from "../../src/audit/terms-audit";
import {
  DomainError,
  MARKET_TERMS,
  ManualClock,
  digest,
} from "../../src/domain";
import type { Market, MarketInput } from "../../src/domain/types";
import { fixtureMarkets } from "../support/fixtures";

test("market admission requires a positive safe-integer adjudication period without partial issuance", () => {
  const engine = new Engine({ clock: () => 1000 });
  try {
    const before = engine.snapshot();
    const market = fixtureMarkets()[0]!;
    const missing: Partial<MarketInput> = { ...market };
    delete missing.adjudicationPeriod;
    const invalid: unknown[] = [
      missing,
      ...[
        undefined,
        null,
        0,
        -1,
        0.5,
        "1000",
        1000n,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ].map((adjudicationPeriod) => ({
        ...market,
        adjudicationPeriod,
      })),
      { ...market, adjudicationPeriod: 8001 },
    ];
    for (const terms of invalid) {
      expect(() =>
        engine.bootstrap({ taker: 100n }, [terms as MarketInput]),
      ).toThrow(DomainError);
      expect(engine.snapshot()).toEqual(before);
    }
  } finally {
    engine.close();
  }
});

test("an exact-fit timetable allows one complete dispute and adjudication window", () => {
  const clock = new ManualClock(1000);
  const engine = new Engine({ clock: clock.now });
  try {
    const terms = { ...fixtureMarkets()[0]!, fallbackAt: 13000 };
    engine.bootstrap({}, [terms]);
    clock.set(11000);
    const proposed = engine.proposeResult("oracle", "propose", {
      marketId: terms.id,
      result: "YES",
      evidence: "Observed at the earliest and latest eligible proposal time",
    });
    expect(proposed.challengeDeadline).toBe(12000);
    expect(proposed.fallbackAt - proposed.challengeDeadline!).toBe(1000);
    expect(engine.audit().ok).toBe(true);
  } finally {
    engine.close();
  }
});

test("adjudication period is stored, immutable and included in the market commitment", () => {
  const first = new Engine({ clock: () => 1000 });
  const second = new Engine({ clock: () => 1000 });
  try {
    const terms = fixtureMarkets()[0]!;
    first.bootstrap({}, [terms]);
    second.bootstrap({}, [{ ...terms, adjudicationPeriod: 2000 }]);
    const market = first.market(terms.id);
    expect(market.adjudicationPeriod).toBe(1000);
    expect(market.termsHash).not.toBe(second.market(terms.id).termsHash);
    const before = first.snapshot();
    expect(() =>
      first.store.run(
        "UPDATE markets SET adjudication_period = ? WHERE id = ?",
        2000,
        terms.id,
      ),
    ).toThrow("immutable market terms");
    expect(first.snapshot()).toEqual(before);
    expect(first.audit().ok).toBe(true);
    expect(second.audit().ok).toBe(true);
  } finally {
    first.close();
    second.close();
  }
});

test("SQL rejects missing or invalid buffers, impossible timetables and late challenge deadlines", () => {
  const engine = new Engine({ clock: () => 1000 });
  try {
    engine.bootstrap({}, [fixtureMarkets()[0]!]);
    const before = engine.snapshot();
    for (const [period, fallback] of [
      [null, 20000],
      [0, 20000],
      [-1, 20000],
      [0.5, 20000],
      ["invalid", 20000],
      [1000, 12999],
    ] as const) {
      expect(() =>
        engine.store.run(
          "INSERT INTO markets(id,description,terms_hash,trading_closes_at,resolve_after,dispute_period,adjudication_period,fallback_at,oracle,arbiter) VALUES(?,?,?,?,?,?,?,?,?,?)",
          "invalid",
          "Invalid timetable",
          "terms",
          10000,
          11000,
          1000,
          period,
          fallback,
          "oracle",
          "arbiter",
        ),
      ).toThrow();
      expect(engine.snapshot()).toEqual(before);
    }
    expect(() =>
      engine.store.run(
        "UPDATE markets SET state='PROPOSED', proposed_result='YES', challenge_deadline=19001 WHERE id=?",
        "market_0",
      ),
    ).toThrow();
    expect(engine.snapshot()).toEqual(before);
  } finally {
    engine.close();
  }
});

test("independent market audit checks timing obligations as well as the committed hash", () => {
  const engine = new Engine({ clock: () => 1000 });
  try {
    engine.bootstrap({}, [fixtureMarkets()[0]!]);
    const market = engine.market("market_0");
    const committed = (values: Partial<Market>): Market => {
      const changed = { ...market, ...values };
      changed.termsHash = digest(
        Object.fromEntries(
          MARKET_TERMS.map((field) => [field, changed[field]]),
        ),
      );
      return changed;
    };
    for (const altered of [
      committed({ adjudicationPeriod: 0 }),
      committed({ adjudicationPeriod: 8001 }),
      committed({
        state: "PROPOSED",
        proposedResult: "YES",
        challengeDeadline: 19001,
      }),
    ]) {
      expect(() =>
        checkMarketTerms(new Map([[altered.id, altered]])),
      ).toThrow();
    }
    const changed = { ...market, adjudicationPeriod: 2000 };
    expect(() => checkMarketTerms(new Map([[changed.id, changed]]))).toThrow(
      "Market terms changed",
    );
  } finally {
    engine.close();
  }
});
