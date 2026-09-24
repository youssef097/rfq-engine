import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/index";
import { fixtureMarkets, initialBalances, TestRig } from "../support/fixtures";
describe("RFQ requests", () => {
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

  test("request nonce remains a tombstone after cancellation", () => {
    const request = rig.request({ nonce: "durable_nonce" });
    rig.engine.cancelRequest("taker", rig.command(), { requestId: request.id });
    expect(() => rig.request({ nonce: "durable_nonce" })).toThrow(DomainError);
  });

  test("request nonce remains a tombstone after fill", () => {
    const request = rig.request({ nonce: "filled_nonce" });
    const quote = rig.quote(request);
    rig.select(request);
    rig.accept(request, quote);
    expect(() =>
      rig.request({ nonce: "filled_nonce", responseDeadline: 3_000 }),
    ).toThrow(DomainError);
  });

  test("nonce is scoped to requester identity", () => {
    const first = rig.request({ nonce: "shared" });
    const second = rig.request({ nonce: "shared" }, "other_taker");
    expect(first.id).not.toBe(second.id);
  });

  test("requester cancellation releases all competing reservations", () => {
    const request = rig.request();
    rig.quote(request);
    rig.quote(request, { payout: 300_000_000n }, "maker_b");
    expect(() =>
      rig.engine.cancelRequest("other_taker", rig.command(), {
        requestId: request.id,
      }),
    ).toThrow(DomainError);
    rig.engine.cancelRequest("taker", rig.command(), { requestId: request.id });
    expect(rig.engine.request(request.id).state).toBe("CANCELLED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
    expect(rig.engine.balance("maker_b")).toBe(2_000_000_000n);
  });

  test("requester can cancel an offered ticket", () => {
    const { request } = rig.offer();
    rig.engine.cancelRequest("taker", rig.command(), { requestId: request.id });
    expect(rig.engine.request(request.id).state).toBe("CANCELLED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
  });

  test("funded ticket cannot be cancelled", () => {
    const { request, quote } = rig.offer();
    rig.accept(request, quote);
    expect(() =>
      rig.engine.cancelRequest("taker", rig.command(), {
        requestId: request.id,
      }),
    ).toThrow(DomainError);
  });

  test("request copies and canonicalizes caller leg data", () => {
    const legs: { marketId: string; side: "YES" | "NO" }[] = [
      { marketId: "market_2", side: "YES" },
      { marketId: "market_0", side: "NO" },
    ];
    const request = rig.request({ legs });
    legs[0]!.side = "NO";
    const stored = rig.engine.request(request.id);
    expect(stored.legs.map((leg) => leg.marketId)).toEqual([
      "market_0",
      "market_2",
    ]);
    expect(stored.legs[1]!.side).toBe("YES");
  });

  test("fixture funding cannot be repeated", () => {
    const before = rig.engine.snapshot();
    expect(() =>
      rig.engine.bootstrap(initialBalances, fixtureMarkets()),
    ).toThrow(DomainError);
    expect(rig.engine.snapshot()).toEqual(before);
  });

  test("32 open request limit releases capacity without reusing old nonce", () => {
    const requests = Array.from({ length: 32 }, () => rig.request());
    const before = rig.engine.snapshot();
    expect(() => rig.request()).toThrow(DomainError);
    expect(rig.engine.snapshot()).toEqual(before);
    rig.engine.cancelRequest("taker", rig.command(), {
      requestId: requests[0]!.id,
    });
    expect(rig.request().state).toBe("COLLECTING");
    expect(() => rig.request({ nonce: requests[0]!.nonce })).toThrow(
      DomainError,
    );
  });
});
