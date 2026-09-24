import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initialBalances, TestRig } from "../support/fixtures";

describe("public queries stay separate from lifecycle commands", () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = new TestRig();
  });
  afterEach(() => rig.close());

  test("reads beyond expiry neither release reservations nor advance committed time", () => {
    const request = rig.request();
    const quote = rig.quote(request);
    rig.clock.set(request.acceptanceDeadline);
    const before = rig.engine.snapshot();

    expect(rig.engine.request(request.id)).toEqual(request);
    expect(rig.engine.quote(quote.id)).toEqual(quote);
    expect(rig.engine.market("market_0").state).toBe("UNRESOLVED");
    expect(rig.engine.balance("maker_a")).toBe(
      initialBalances.maker_a - (quote.payout - request.stake),
    );
    expect(rig.engine.balance("unknown_account")).toBe(0n);
    expect(rig.engine.audit().ok).toBe(true);
    expect(rig.engine.snapshot()).toEqual(before);

    const recovered = rig.engine.recover("keeper", "expire_after_read");
    expect(recovered.requests).toBe(1);
    expect(rig.engine.request(request.id).state).toBe("EXPIRED");
    expect(rig.engine.quote(quote.id).state).toBe("EXPIRED");
    expect(rig.engine.balance("maker_a")).toBe(initialBalances.maker_a);
    expect(rig.engine.audit().ok).toBe(true);
  });

  test("reading a funded ticket after fallback does not finalize markets or pay escrow", () => {
    const { request, quote } = rig.offer();
    const position = rig.accept(request, quote);
    if (!("payout" in position)) throw new Error("Expected a funded position");
    rig.clock.set(20_000);
    const before = rig.engine.snapshot();

    expect(rig.engine.position(position.id)).toEqual(position);
    expect(rig.engine.request(request.id).state).toBe("FILLED");
    expect(rig.engine.quote(quote.id).state).toBe("ACCEPTED");
    for (const leg of position.legs)
      expect(rig.engine.market(leg.marketId).state).toBe("UNRESOLVED");
    expect(rig.engine.balance("taker")).toBe(
      initialBalances.taker - position.stake,
    );
    expect(rig.engine.audit().ok).toBe(true);
    expect(rig.engine.snapshot()).toEqual(before);

    const recovered = rig.engine.recover("keeper", "settle_after_read");
    expect(recovered.markets).toBe(3);
    expect(recovered.positions).toBe(1);
    expect(rig.engine.position(position.id).state).toBe("VOID");
    expect(rig.engine.balance("taker")).toBe(initialBalances.taker);
    expect(rig.engine.balance("maker_a")).toBe(initialBalances.maker_a);
    expect(rig.engine.audit().ok).toBe(true);
  });

  test("returned records and nested selections are detached from durable state", () => {
    const { request, quote } = rig.offer();
    const position = rig.accept(request, quote);
    if (!("payout" in position)) throw new Error("Expected a funded position");
    const before = rig.engine.snapshot();
    const readRequest = rig.engine.request(request.id);
    const readQuote = rig.engine.quote(quote.id);
    const readPosition = rig.engine.position(position.id);
    const readMarket = rig.engine.market("market_0");
    const snapshot = rig.engine.snapshot();

    readRequest.legs[0]!.side = "NO";
    readRequest.legs.pop();
    readRequest.stake = 1n;
    readQuote.payout = 2n;
    readPosition.legs[0]!.marketTermsHash = "substituted";
    readPosition.state = "WON";
    readMarket.adjudicationPeriod = 1;
    snapshot.balances![0]!.amount = 0n;
    snapshot.request_legs!.length = 0;

    expect(rig.engine.snapshot()).toEqual(before);
    expect(rig.engine.position(position.id)).toEqual(position);
    expect(rig.engine.audit().ok).toBe(true);
  });
});
