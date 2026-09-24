import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/index";
import { balance, escrow, reserved } from "../../src/storage/ledger";
import { fixtureMarkets, TestRig } from "../support/fixtures";
describe("RFQ acceptance", () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = new TestRig();
  });
  afterEach(() => {
    try {
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("three legs fund one immutable position and one escrow", () => {
    const { request, quote } = rig.offer();
    const result = rig.accept(request, quote);
    expect(result.state).toBe("OPEN");
    const position = rig.engine.position(result.id);
    expect(position.legs).toHaveLength(3);
    expect(position.quoteId).toBe(quote.id);
    expect(position.stake).toBe(100_000_000n);
    expect(position.makerCollateral).toBe(250_000_000n);
    expect(position.payout).toBe(350_000_000n);
    expect(rig.engine.snapshot().positions).toHaveLength(1);
    expect(balance(rig.engine.store, escrow(position.id))).toBe(350_000_000n);
    expect(balance(rig.engine.store, reserved(quote.id))).toBe(0n);
    expect(rig.engine.balance("taker")).toBe(900_000_000n);
    expect(rig.engine.balance("maker_a")).toBe(1_750_000_000n);
    expect(rig.engine.request(request.id).state).toBe("FILLED");
  });

  test("a single bet is a one-leg ticket", () => {
    const request = rig.request({
      legs: [{ marketId: "market_0", side: "NO" }],
    });
    const quote = rig.quote(request);
    rig.select(request);
    expect(
      rig.engine.position(rig.accept(request, quote).id).legs,
    ).toHaveLength(1);
  });

  test("only the requester may accept", () => {
    const { request, quote } = rig.offer();
    const before = rig.engine.snapshot();
    expect(() =>
      rig.accept(request, quote, rig.command(), "other_taker"),
    ).toThrow(DomainError);
    expect(rig.engine.snapshot()).toEqual(before);
  });

  test("acceptance exactly at request deadline fails", () => {
    const { request, quote } = rig.offer();
    rig.clock.set(5_000);
    expect(rig.accept(request, quote).state).toBe("EXPIRED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
  });

  test.each([
    [3_999, "REJECTED", "INVALID_LEG"],
    [4_000, "EXPIRED", "SELECTED_QUOTE_EXPIRED"],
    [5_000, "EXPIRED", "ACCEPTANCE_DEADLINE"],
  ] as const)(
    "refresh at %i closes with %s / %s when a leg is also halted",
    (now, state, reason) => {
      const request = rig.request();
      const selected = rig.quote(request, { expiresAt: 4_000 });
      const rival = rig.quote(request, { payout: 300_000_000n }, "maker_b");
      rig.select(request);
      rig.engine.haltMarket("operator", rig.command(), {
        marketId: "market_1",
        reason: "invalid source",
      });
      rig.clock.set(now);

      expect(rig.accept(request, selected)).toMatchObject({ state, reason });
      for (const quote of [selected, rival]) {
        expect(rig.engine.quote(quote.id).state).toBe(state);
        expect(balance(rig.engine.store, reserved(quote.id))).toBe(0n);
        expect(rig.engine.balance(quote.maker)).toBe(2_000_000_000n);
      }
      expect(rig.engine.balance("taker")).toBe(1_000_000_000n);
      expect(rig.engine.snapshot().positions).toHaveLength(0);
    },
  );

  test.each([
    "after_stake_debit",
    "after_maker_debit",
    "after_leg:0",
    "before_commit",
  ])("%s rolls back ticket, money, events and receipt", (stage) => {
    const request = rig.request();
    const quote = rig.quote(request);
    rig.quote(request, { payout: 300_000_000n }, "maker_b");
    rig.select(request);
    const before = rig.engine.snapshot();
    const command = rig.command();
    rig.faultStage = stage;
    expect(() => rig.accept(request, quote, command)).toThrow(
      `injected failure: ${stage}`,
    );
    expect(rig.engine.snapshot()).toEqual(before);
    rig.faultStage = null;
    expect(
      rig.engine.position(rig.accept(request, quote, command).id).legs,
    ).toHaveLength(3);
  });

  test("lost response replays durable bigint receipt without another debit", () => {
    const { request, quote } = rig.offer();
    const command = rig.command();
    rig.faultStage = "after_commit";
    expect(() => rig.accept(request, quote, command)).toThrow("after_commit");
    rig.faultStage = null;
    const before = rig.engine.snapshot();
    const result = rig.accept(request, quote, command);
    expect(result.state).toBe("OPEN");
    expect(typeof result.stake).toBe("bigint");
    expect(rig.engine.snapshot()).toEqual(before);
    expect(rig.engine.balance("taker")).toBe(900_000_000n);
  });

  test("fresh command cannot accept a consumed request again", () => {
    const { request, quote } = rig.offer();
    rig.accept(request, quote);
    const before = rig.engine.snapshot();
    expect(() => rig.accept(request, quote)).toThrow(DomainError);
    expect(rig.engine.snapshot()).toEqual(before);
  });

  test("fresh command cannot execute losing quote after fill", () => {
    const request = rig.request();
    const winner = rig.quote(request);
    const loser = rig.quote(request, { payout: 300_000_000n }, "maker_b");
    rig.select(request);
    rig.accept(request, winner);
    expect(() => rig.accept(request, loser)).toThrow(DomainError);
    expect(rig.engine.balance("taker")).toBe(900_000_000n);
    expect(rig.engine.balance("maker_b")).toBe(2_000_000_000n);
  });

  test("same command ID with different payload is rejected", () => {
    const request = rig.request();
    const winner = rig.quote(request);
    const loser = rig.quote(request, { payout: 300_000_000n }, "maker_b");
    rig.select(request);
    const command = rig.command();
    rig.accept(request, winner, command);
    const before = rig.engine.snapshot();
    expect(() => rig.accept(request, loser, command)).toThrow(DomainError);
    expect(rig.engine.snapshot()).toEqual(before);
  });

  test("different requests cannot spend the same requester balance", () => {
    const first = rig.request({ stake: 600_000_000n });
    const second = rig.request({ stake: 600_000_000n });
    const a = rig.quote(first, { payout: 800_000_000n });
    const b = rig.quote(second, { payout: 800_000_000n }, "maker_b");
    rig.select(first);
    rig.select(second);
    rig.accept(first, a);
    expect(rig.accept(second, b).state).toBe("REJECTED");
    expect(rig.engine.balance("taker")).toBe(400_000_000n);
    expect(rig.engine.balance("maker_b")).toBe(2_000_000_000n);
  });

  test("halted leg 2 rejects whole offer and releases every maker", () => {
    const request = rig.request();
    const quote = rig.quote(request);
    rig.quote(request, { payout: 300_000_000n }, "maker_b");
    rig.select(request);
    rig.engine.haltMarket("operator", rig.command(), {
      marketId: "market_1",
      reason: "invalid source",
    });
    expect(rig.accept(request, quote).state).toBe("REJECTED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
    expect(rig.engine.balance("maker_b")).toBe(2_000_000_000n);
    expect(rig.engine.balance("taker")).toBe(1_000_000_000n);
    expect(rig.engine.snapshot().positions).toHaveLength(0);
  });

  test("market halt requires operator identity", () => {
    expect(() =>
      rig.engine.haltMarket("taker", rig.command(), {
        marketId: "market_1",
        reason: "attempt",
      }),
    ).toThrow(DomainError);
    expect(rig.engine.market("market_1").halted).toBe(0);
  });

  test("receipt replay after restart preserves bigint types exactly", () => {
    const { request, quote } = rig.offer();
    const command = rig.command();
    const original = rig.accept(request, quote, command);
    rig.reopen();
    const before = rig.engine.snapshot();
    const replay = rig.accept(request, quote, command);
    expect(replay).toEqual(original);
    expect(typeof replay.stake).toBe("bigint");
    expect(rig.engine.snapshot()).toEqual(before);
  });

  test("maximum eight-leg ticket funds atomically", () => {
    rig.close();
    const base = fixtureMarkets()[0]!;
    rig = new TestRig({
      markets: Array.from({ length: 8 }, (_, index) => ({
        ...base,
        id: `market_${index}`,
      })),
    });
    const request = rig.request({
      legs: Array.from({ length: 8 }, (_, index) => ({
        marketId: `market_${index}`,
        side: "YES",
      })),
    });
    const quote = rig.quote(request);
    rig.select(request);
    expect(
      rig.engine.position(rig.accept(request, quote).id).legs,
    ).toHaveLength(8);
  });
});
