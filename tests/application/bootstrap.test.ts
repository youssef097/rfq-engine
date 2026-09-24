import { expect, test } from "bun:test";
import { DomainError, Engine } from "../../src/index";
import { fixtureMarkets, initialBalances } from "../support/fixtures";

test("a mid-bootstrap storage failure rolls back issuance, market terms and initialization", () => {
  const engine = new Engine({ clock: () => 1_000 });
  try {
    // Abort the second market insertion after balances, journal and the first
    // market/event have been written, exercising the complete setup transaction.
    engine.store.db.exec(`
      CREATE TEMP TRIGGER fail_second_fixture_market
      BEFORE INSERT ON markets WHEN NEW.id = 'market_1'
      BEGIN SELECT RAISE(ABORT, 'injected fixture failure'); END;
    `);
    const before = engine.snapshot();
    expect(() => engine.bootstrap(initialBalances, fixtureMarkets())).toThrow(
      "injected fixture failure",
    );
    expect(engine.snapshot()).toEqual(before);
    engine.store.db.exec("DROP TRIGGER fail_second_fixture_market");

    engine.bootstrap(initialBalances, fixtureMarkets(), "custom_operator");
    expect(engine.balance("taker")).toBe(initialBalances.taker);
    expect(engine.snapshot().markets).toHaveLength(3);
    expect(engine.audit().ok).toBe(true);
    expect(() =>
      engine.haltMarket("operator", "wrong_operator", {
        marketId: "market_0",
        reason: "not the bootstrapped authority",
      }),
    ).toThrow(DomainError);
    expect(
      engine.haltMarket("custom_operator", "right_operator", {
        marketId: "market_0",
        reason: "bootstrapped authority",
      }).halted,
    ).toBe(1);
    expect(engine.audit().ok).toBe(true);
  } finally {
    engine.close();
  }
});

test("duplicate or already-closed fixture markets reject before any partial issuance", () => {
  const engine = new Engine({ clock: () => 1_000 });
  try {
    const before = engine.snapshot();
    const markets = fixtureMarkets();
    expect(() =>
      engine.bootstrap(initialBalances, [markets[0]!, markets[0]!]),
    ).toThrow("Duplicate fixture market");
    expect(engine.snapshot()).toEqual(before);
    expect(() =>
      engine.bootstrap(initialBalances, [
        {
          ...markets[0]!,
          tradingClosesAt: 1_000,
        },
      ]),
    ).toThrow("Fixture markets must still be tradable");
    expect(engine.snapshot()).toEqual(before);
    engine.bootstrap(initialBalances, markets);
    expect(engine.audit().ok).toBe(true);
  } finally {
    engine.close();
  }
});
