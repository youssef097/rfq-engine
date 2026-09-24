import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DomainError, quotePrice } from "../../src/domain/index";
import type { SubmitQuoteArgs } from "../../src/engine";
import { available, reserved } from "../../src/storage/ledger";
import { initialBalances, TestRig } from "../support/fixtures";
describe("RFQ quotes", () => {
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

  function fullBook(
    overrides: (index: number) => Partial<SubmitQuoteArgs> = () => ({}),
    makerBalance = 10_000_000n,
  ) {
    rig.close();
    rig = new TestRig({
      balances: {
        ...initialBalances,
        ...Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [
            `book_maker_${index}`,
            makerBalance,
          ]),
        ),
      },
    });
    const request = rig.request();
    const quotes = Array.from({ length: 32 }, (_, index) =>
      rig.quote(
        request,
        { payout: 100_000_002n, ...overrides(index) },
        `book_maker_${index}`,
      ),
    );
    return { request, quotes };
  }

  test("best quote uses exact payout even when rounded prices match", () => {
    const request = rig.request();
    rig.quote(request, { payout: 350_000_000n });
    const higher = rig.quote(request, { payout: 350_000_001n }, "maker_b");
    expect(quotePrice(request.stake, 350_000_000n)).toBe(
      quotePrice(request.stake, 350_000_001n),
    );
    expect(rig.select(request).selectedQuoteId).toBe(higher.id);
    const position = rig.engine.position(rig.accept(request, higher).id);
    expect(position.payout).toBe(350_000_001n);
    expect(position.makerCollateral).toBe(250_000_001n);
  });

  test("equal payout ties use receipt sequence rather than maker or quote identifiers", () => {
    rig.close();
    let serial = 100;
    rig = new TestRig({ idFactory: () => `id_${--serial}` });
    const request = rig.request();
    const first = rig.quote(request, {}, "maker_b");
    const second = rig.quote(request, {}, "maker_a");
    expect(first.id > second.id).toBe(true);
    expect(first.createdAt).toBe(second.createdAt);
    expect(rig.select(request).selectedQuoteId).toBe(first.id);
  });

  test("quotes reserve full maker liability and reject insufficient funds", () => {
    const request = rig.request();
    const quote = rig.quote(request);
    expect(rig.engine.balance("maker_a")).toBe(1_750_000_000n);
    expect(() => rig.quote(request, {}, "poor_maker")).toThrow(DomainError);
    expect(rig.engine.balance("poor_maker")).toBe(100_000_000n);
    expect(rig.engine.quote(quote.id).state).toBe("LIVE");
  });

  test("one maker cannot submit two active quotes for one request", () => {
    const request = rig.request();
    rig.quote(request);
    const before = rig.engine.snapshot();
    expect(() => rig.quote(request, { payout: 400_000_000n })).toThrow(
      DomainError,
    );
    expect(rig.engine.snapshot()).toEqual(before);
  });

  test("acceptance names exact selected quote and releases losing reservations", () => {
    const request = rig.request();
    const loser = rig.quote(request, { payout: 300_000_000n });
    const winner = rig.quote(request, {}, "maker_b");
    rig.select(request);
    expect(() => rig.accept(request, loser)).toThrow(DomainError);
    expect(rig.engine.balance("maker_a")).toBe(1_800_000_000n);
    rig.accept(request, winner);
    expect(rig.engine.quote(loser.id).state).toBe("REJECTED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
    expect(rig.engine.quote(winner.id).state).toBe("ACCEPTED");
  });

  test("selection waits until collection ends", () => {
    const request = rig.request();
    rig.quote(request);
    expect(() =>
      rig.engine.select("keeper", rig.command(), { requestId: request.id }),
    ).toThrow(DomainError);
  });

  test("submission exactly at collection deadline fails", () => {
    const request = rig.request();
    rig.clock.set(2_000);
    expect(() => rig.quote(request)).toThrow(DomainError);
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
  });

  test.each(["accept", "select", "cancelRequest"] as const)(
    "%s closes an expired selected offer without substituting its live rival",
    (operation) => {
      const request = rig.request();
      const selected = rig.quote(request, { expiresAt: 4_000 });
      const rival = rig.quote(request, { payout: 300_000_000n }, "maker_b");
      rig.select(request);
      rig.clock.set(4_000);

      const result =
        operation === "accept"
          ? rig.accept(request, selected)
          : rig.engine[operation]("taker", rig.command(), {
              requestId: request.id,
            });
      expect(result).toMatchObject({
        state: "EXPIRED",
        reason: "SELECTED_QUOTE_EXPIRED",
        selectedQuoteId: selected.id,
      });
      expect(rig.engine.quote(selected.id).state).toBe("EXPIRED");
      expect(rig.engine.quote(rival.id).state).toBe("EXPIRED");
      expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
      expect(rig.engine.balance("maker_b")).toBe(2_000_000_000n);
      expect(rig.engine.balance("taker")).toBe(1_000_000_000n);
      expect(rig.engine.snapshot().positions).toHaveLength(0);
    },
  );

  test("failed admission rolls back expired quote cleanup, then the same maker can reuse its backing", () => {
    rig.close();
    rig = new TestRig({
      balances: {
        taker: 1_000_000_000n,
        maker_a: 250_000_000n,
        poor_maker: 100_000_000n,
      },
    });
    const request = rig.request();
    const expired = rig.quote(request, { expiresAt: 1_500 });
    expect(rig.engine.balance("maker_a")).toBe(0n);
    rig.clock.set(1_500);
    const before = rig.engine.snapshot();

    expect(() => rig.quote(request, {}, "poor_maker")).toThrow(
      "Source account lacks sufficient available funds",
    );
    expect(rig.engine.snapshot()).toEqual(before);

    const renewed = rig.quote(request);
    expect(renewed.state).toBe("LIVE");
    expect(renewed.replacesQuoteId).toBeNull();
    expect(rig.engine.quote(expired.id).state).toBe("EXPIRED");
    expect(rig.engine.balance("maker_a")).toBe(0n);
    expect(rig.engine.balance("poor_maker")).toBe(100_000_000n);
  });

  test("selection discards expired best quote", () => {
    const request = rig.request();
    const expired = rig.quote(request, {
      payout: 400_000_000n,
      expiresAt: 2_000,
    });
    const live = rig.quote(request, { payout: 300_000_000n }, "maker_b");
    expect(rig.select(request).selectedQuoteId).toBe(live.id);
    expect(rig.engine.quote(expired.id).state).toBe("EXPIRED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
  });

  test("no eligible quote rejects complete request", () => {
    const request = rig.request();
    rig.quote(request, { expiresAt: 2_000 });
    expect(rig.select(request).state).toBe("REJECTED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
  });

  test("maker cancellation requires owner and unlocked quote", () => {
    const request = rig.request();
    const quote = rig.quote(request);
    expect(() =>
      rig.engine.cancelQuote("maker_b", rig.command(), { quoteId: quote.id }),
    ).toThrow(DomainError);
    rig.engine.cancelQuote("maker_a", rig.command(), { quoteId: quote.id });
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
    const replacement = rig.quote(request, { payout: 400_000_000n });
    rig.select(request);
    expect(() =>
      rig.engine.cancelQuote("maker_a", rig.command(), {
        quoteId: replacement.id,
      }),
    ).toThrow(DomainError);
  });

  test("maker cannot cancel exactly at collection close", () => {
    const request = rig.request();
    const quote = rig.quote(request);
    rig.clock.set(2_000);
    expect(() =>
      rig.engine.cancelQuote("maker_a", rig.command(), { quoteId: quote.id }),
    ).toThrow(DomainError);
  });

  test("quotes reject changed commitments and inconsistent price or expiry", () => {
    const request = rig.request();
    const wrongHash =
      request.termsHash.slice(0, -1) +
      (request.termsHash.endsWith("0") ? "1" : "0");
    const invalid = [
      { requestHash: wrongHash },
      { requestHash: "not_a_hash" },
      { requestHash: true },
      { priceE6: true },
      { priceE6: 285_714 },
      { priceE6: quotePrice(100_000_000n, 350_000_000n) + 1n },
      { expiresAt: true },
      { expiresAt: 1_000 },
      { expiresAt: 5_001 },
    ];
    for (const overrides of invalid) {
      const before = rig.engine.snapshot();
      expect(() => rig.quote(request, overrides as never)).toThrow(DomainError);
      expect(rig.engine.snapshot()).toEqual(before);
    }
  });

  test("invalid payouts are rejected before any reservation", () => {
    const request = rig.request();
    const invalid: unknown[] = [
      true,
      0n,
      -1n,
      100_000_000n,
      350_000_000,
      1.1,
      "350000000",
      9_000_000_000_000_001n,
    ];
    for (const payout of invalid) {
      const before = rig.engine.snapshot();
      expect(() =>
        rig.engine.submitQuote("maker_a", rig.command(), {
          requestId: request.id,
          requestHash: request.termsHash,
          payout: payout as never,
          priceE6: 285_714n,
          expiresAt: 5_000,
        }),
      ).toThrow(DomainError);
      expect(rig.engine.snapshot()).toEqual(before);
    }
  });

  test("self-quote is rejected", () => {
    expect(() => rig.quote(rig.request(), {}, "taker")).toThrow(DomainError);
  });

  test("32 active quote limit releases capacity after cancellation", () => {
    rig.close();
    const makers = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [
        `bounded_maker_${index}`,
        10_000_000n,
      ]),
    );
    rig = new TestRig({ balances: { ...initialBalances, ...makers } });
    const request = rig.request();
    const quotes = Array.from({ length: 32 }, (_, index) =>
      rig.quote(request, { payout: 102_000_000n }, `bounded_maker_${index}`),
    );
    const before = rig.engine.snapshot();
    expect(() =>
      rig.quote(request, { payout: 102_000_000n }, "bounded_maker_32"),
    ).toThrow(DomainError);
    expect(rig.engine.snapshot()).toEqual(before);
    rig.engine.cancelQuote("bounded_maker_0", rig.command(), {
      quoteId: quotes[0]!.id,
    });
    expect(
      rig.quote(request, { payout: 102_000_000n }, "bounded_maker_32").state,
    ).toBe("LIVE");
    expect(rig.engine.balance("bounded_maker_0")).toBe(10_000_000n);
  });

  test("32 one-micro-unit Sybil quotes cannot exclude a better funded offer", () => {
    const { request, quotes } = fullBook(() => ({ payout: 100_000_001n }), 1n);
    const replacement = rig.quote(request);
    const displaced = quotes[31]!;
    expect(replacement.replacesQuoteId).toBe(displaced.id);
    expect(rig.engine.quote(displaced.id).state).toBe("REJECTED");
    for (const [index, quote] of quotes.entries()) {
      expect(rig.engine.balance(quote.maker)).toBe(index === 31 ? 1n : 0n);
      if (index < 31) expect(rig.engine.quote(quote.id).state).toBe("LIVE");
    }
    expect(rig.engine.balance("maker_a")).toBe(1_750_000_000n);
    expect(
      rig.engine.snapshot().quotes!.filter((quote) => quote.state === "LIVE"),
    ).toHaveLength(32);
    expect(
      rig.engine.store.all(
        "SELECT source,destination,amount FROM journal WHERE reference=? AND reason='release_quote'",
        displaced.id,
      ),
    ).toEqual([
      {
        source: reserved(displaced.id),
        destination: available(displaced.maker),
        amount: 1n,
      },
    ]);
    expect(rig.select(request).selectedQuoteId).toBe(replacement.id);
  });

  test("expired liquidity frees a full-book slot without imposing competitive replacement rules", () => {
    const { request, quotes } = fullBook((index) => ({
      expiresAt: index === 31 ? 1_500 : 5_000,
    }));
    rig.clock.set(1_500);
    const admitted = rig.quote(request, {
      payout: 100_000_002n,
      expiresAt: 2_000,
    });
    expect(admitted.replacesQuoteId).toBeNull();
    expect(rig.engine.quote(quotes[31]!.id).state).toBe("EXPIRED");
    expect(rig.engine.balance(quotes[31]!.maker)).toBe(10_000_000n);
    expect(
      rig.engine.snapshot().quotes!.filter((quote) => quote.state === "LIVE"),
    ).toHaveLength(32);
    expect(
      rig.engine.cancelQuote("maker_a", rig.command(), {
        quoteId: admitted.id,
      }).state,
    ).toBe("CANCELLED");
  });

  test.each([100_000_001n, 100_000_002n])(
    "full book rejects equal or worse payout %s without mutation",
    (payout) => {
      const { request } = fullBook();
      const before = rig.engine.snapshot();
      expect(() => rig.quote(request, { payout })).toThrow(
        "A full book requires",
      );
      expect(rig.engine.snapshot()).toEqual(before);
    },
  );

  test("shorter-lived price improvement cannot displace durable liquidity", () => {
    const { request } = fullBook();
    const before = rig.engine.snapshot();
    expect(() => rig.quote(request, { expiresAt: 4_000 })).toThrow(
      "A full book requires",
    );
    expect(rig.engine.snapshot()).toEqual(before);
  });

  test("replacement ranks only quotes whose expiry it can preserve", () => {
    const { request, quotes } = fullBook((index) => ({
      payout: index === 31 ? 100_000_003n : 100_000_002n,
      expiresAt: index === 31 ? 3_000 : 5_000,
    }));
    const replacement = rig.quote(request, { expiresAt: 4_000 });
    expect(replacement.replacesQuoteId).toBe(quotes[31]!.id);
    expect(rig.engine.quote(quotes[0]!.id).state).toBe("LIVE");
  });

  test("underfunded replacement restores displaced liquidity and its receipt", () => {
    const { request } = fullBook();
    const before = rig.engine.snapshot();
    expect(() => rig.quote(request, {}, "poor_maker")).toThrow(
      "Source account lacks sufficient available funds",
    );
    expect(rig.engine.snapshot()).toEqual(before);
  });

  test.each(["after_quote_displacement", "before_commit"])(
    "%s restores the complete full book before retry",
    (stage) => {
      const { request } = fullBook();
      const before = rig.engine.snapshot();
      const command = rig.command();
      const args = {
        requestId: request.id,
        requestHash: request.termsHash,
        payout: 350_000_000n,
        priceE6: quotePrice(request.stake, 350_000_000n),
        expiresAt: 5_000,
      };
      rig.faultStage = stage;
      expect(() => rig.engine.submitQuote("maker_a", command, args)).toThrow(
        stage,
      );
      expect(rig.engine.snapshot()).toEqual(before);
      rig.faultStage = null;
      expect(rig.engine.submitQuote("maker_a", command, args).state).toBe(
        "LIVE",
      );
    },
  );

  test("replacement replay after a lost response cannot release or debit twice", () => {
    const { request, quotes } = fullBook();
    const command = rig.command();
    const args = {
      requestId: request.id,
      requestHash: request.termsHash,
      payout: 350_000_000n,
      priceE6: quotePrice(request.stake, 350_000_000n),
      expiresAt: 5_000,
    };
    rig.faultStage = "after_commit";
    expect(() => rig.engine.submitQuote("maker_a", command, args)).toThrow(
      "after_commit",
    );
    rig.faultStage = null;
    rig.reopen();
    const before = rig.engine.snapshot();
    const replay = rig.engine.submitQuote("maker_a", command, args);
    expect("replacesQuoteId" in replay && replay.replacesQuoteId).toBe(
      quotes[31]!.id,
    );
    expect(rig.engine.snapshot()).toEqual(before);
    expect(rig.engine.balance(quotes[31]!.maker)).toBe(10_000_000n);
  });

  test("replacement cannot evict liquidity then cancel during collection", () => {
    const { request } = fullBook(() => ({ expiresAt: 4_000 }));
    const replacement = rig.quote(request, { expiresAt: 4_000 });
    rig.reopen();
    const before = rig.engine.snapshot();
    expect(() =>
      rig.engine.store.transaction(() =>
        rig.engine.store.run(
          "UPDATE quotes SET replaces_quote_id=NULL WHERE id=?",
          replacement.id,
        ),
      ),
    ).toThrow("immutable quote terms");
    expect(rig.engine.snapshot()).toEqual(before);
    expect(() =>
      rig.engine.cancelQuote("maker_a", rig.command(), {
        quoteId: replacement.id,
      }),
    ).toThrow("firm until expiry");
    expect(rig.engine.snapshot()).toEqual(before);
    rig.clock.set(4_000);
    expect(
      rig.engine.cancelQuote("maker_a", rig.command(), {
        quoteId: replacement.id,
      }).state,
    ).toBe("EXPIRED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
  });

  test("successive replacements preserve firmness and failed replacements preserve incumbents", () => {
    const { request, quotes } = fullBook(
      (index) => ({ payout: index === 31 ? 100_000_002n : 400_000_000n }),
      500_000_000n,
    );
    const command = rig.command();
    const args = {
      requestId: request.id,
      requestHash: request.termsHash,
      payout: 200_000_000n,
      priceE6: quotePrice(request.stake, 200_000_000n),
      expiresAt: 5_000,
    };
    const first = rig.engine.submitQuote("maker_a", command, args);
    if (!("replacesQuoteId" in first))
      throw new Error("Expected a replacement quote");
    expect(first.replacesQuoteId).toBe(quotes[31]!.id);
    const before = rig.engine.snapshot();
    expect(() =>
      rig.quote(request, { payout: 300_000_000n }, "poor_maker"),
    ).toThrow("Source account lacks sufficient available funds");
    expect(rig.engine.snapshot()).toEqual(before);
    const second = rig.quote(request, { payout: 300_000_000n }, "maker_b");
    expect(second.replacesQuoteId).toBe(first.id);
    expect(rig.engine.quote(first.id).state).toBe("REJECTED");
    expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
    const replaced = rig.engine.snapshot();
    expect(rig.engine.submitQuote("maker_a", command, args)).toEqual(first);
    expect(rig.engine.snapshot()).toEqual(replaced);
    expect(() =>
      rig.engine.cancelQuote("maker_b", rig.command(), { quoteId: second.id }),
    ).toThrow("firm until expiry");
    rig.engine.cancelRequest("taker", rig.command(), { requestId: request.id });
    expect(rig.engine.quote(second.id).state).toBe("REJECTED");
    expect(rig.engine.balance("maker_b")).toBe(2_000_000_000n);
  });

  test("database protects terms selections and nonce tombstones from direct mutation", () => {
    const request = rig.request();
    const quote = rig.quote(request);
    const loser = rig.quote(request, { payout: 300_000_000n }, "maker_b");
    rig.select(request);
    const before = rig.engine.snapshot();
    const attempts: [string, string][] = [
      ["UPDATE requests SET stake=stake+1 WHERE id=?", request.id],
      ["UPDATE requests SET nonce='replacement' WHERE id=?", request.id],
      ["UPDATE request_legs SET side='NO' WHERE request_id=?", request.id],
      ["UPDATE quotes SET payout=payout+1 WHERE id=?", quote.id],
      ["UPDATE markets SET description='changed' WHERE id=?", "market_0"],
      ["DELETE FROM requests WHERE id=?", request.id],
    ];
    for (const [sql, id] of attempts) {
      expect(() =>
        rig.engine.store.transaction(() => rig.engine.store.run(sql, id)),
      ).toThrow();
      expect(rig.engine.snapshot()).toEqual(before);
    }
    expect(() =>
      rig.engine.store.transaction(() =>
        rig.engine.store.run(
          "UPDATE requests SET selected_quote_id=? WHERE id=?",
          loser.id,
          request.id,
        ),
      ),
    ).toThrow();
    expect(rig.engine.snapshot()).toEqual(before);
    const position = rig.engine.position(rig.accept(request, quote).id);
    const funded = rig.engine.snapshot();
    expect(() =>
      rig.engine.store.transaction(() =>
        rig.engine.store.run(
          "UPDATE positions SET maker_collateral=maker_collateral+1 WHERE id=?",
          position.id,
        ),
      ),
    ).toThrow();
    expect(() =>
      rig.engine.store.transaction(() =>
        rig.engine.store.run(
          "UPDATE position_legs SET side='NO' WHERE position_id=?",
          position.id,
        ),
      ),
    ).toThrow();
    expect(() =>
      rig.engine.store.transaction(() =>
        rig.engine.store.run(
          "UPDATE requests SET state='OFFERED' WHERE id=?",
          request.id,
        ),
      ),
    ).toThrow();
    expect(rig.engine.snapshot()).toEqual(funded);
  });
});
