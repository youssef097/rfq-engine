import { expect, test } from "bun:test";
import { MAX_QUOTES } from "../../src/domain/index";
import type { RequestRecord } from "../../src/domain/types";
import { initialBalances, TestRig } from "../support/fixtures";

const fillerBalances = Object.fromEntries(
  Array.from({ length: MAX_QUOTES - 1 }, (_, index) => [
    `filler_${index}`,
    200_000_000n,
  ]),
);
const balances = { ...initialBalances, ...fillerBalances };

function fillBook(rig: TestRig, request: RequestRecord) {
  const first = rig.quote(
    request,
    { payout: request.stake + 1n, expiresAt: 4_000 },
    "maker_a",
  );
  for (const maker of Object.keys(fillerBalances))
    rig.quote(request, { payout: 200_000_000n, expiresAt: 4_000 }, maker);
  return first;
}

test("audit reconciles chained quote replacements and all expiry refunds", () => {
  const rig = new TestRig({ balances });
  try {
    const request = rig.request();
    const first = fillBook(rig, request);
    const second = rig.quote(
      request,
      { payout: request.stake + 2n, expiresAt: 4_000 },
      "maker_b",
    );
    const third = rig.quote(
      request,
      { payout: request.stake + 3n, expiresAt: 4_000 },
      "maker_c",
    );
    expect(second.replacesQuoteId).toBe(first.id);
    expect(third.replacesQuoteId).toBe(second.id);
    expect(rig.engine.quote(first.id).state).toBe("REJECTED");
    expect(rig.engine.quote(second.id).state).toBe("REJECTED");
    expect(rig.engine.quote(third.id).state).toBe("LIVE");
    expect(rig.engine.balance("maker_a")).toBe(balances.maker_a);
    expect(rig.engine.balance("maker_b")).toBe(balances.maker_b);
    expect(rig.engine.balance("maker_c")).toBe(balances.maker_c - 3n);
    const funded = rig.engine.audit().totalFunded;

    rig.reopen();
    expect(rig.engine.audit().totalFunded).toBe(funded);
    rig.clock.set(4_000);
    expect(
      rig.engine.recover("keeper", rig.command(), { limit: MAX_QUOTES }).quotes,
    ).toBe(MAX_QUOTES);
    expect(rig.engine.quote(third.id).state).toBe("EXPIRED");
    for (const [actor, amount] of Object.entries(balances))
      expect(rig.engine.balance(actor)).toBe(amount);
    expect(rig.engine.audit().totalFunded).toBe(funded);

    // Repeated recovery must not refund either predecessor a second time.
    expect(
      rig.engine.recover("keeper", rig.command(), { limit: MAX_QUOTES }).quotes,
    ).toBe(0);
    expect(rig.engine.audit().totalFunded).toBe(funded);
  } finally {
    rig.close();
  }
});

test("audit rejects a cross-request replacement link despite conserved money", () => {
  const rig = new TestRig({ balances });
  try {
    const unrelated = rig.request();
    const unrelatedQuote = rig.quote(unrelated, {
      payout: unrelated.stake + 1n,
      expiresAt: 4_000,
    });
    rig.engine.cancelRequest("taker", rig.command(), {
      requestId: unrelated.id,
    });
    const request = rig.request();
    fillBook(rig, request);
    const replacement = rig.quote(
      request,
      { payout: request.stake + 2n, expiresAt: 4_000 },
      "maker_b",
    );
    expect(rig.engine.audit().ok).toBe(true);
    const before = rig.engine.snapshot();

    // Privileged fault injection bypasses only immutable quote metadata. The
    // predecessor exists and was refunded, but belongs to another request.
    rig.engine.store.transaction(() => {
      rig.engine.store.run("DROP TRIGGER quotes_immutable_terms");
      rig.engine.store.run(
        "UPDATE quotes SET replaces_quote_id=? WHERE id=?",
        unrelatedQuote.id,
        replacement.id,
      );
    });
    const after = rig.engine.snapshot();
    if (
      !before.balances ||
      !before.journal ||
      !after.balances ||
      !after.journal
    )
      throw new Error("Snapshot must include balances and journal");
    expect(after.balances).toEqual(before.balances);
    expect(after.journal).toEqual(before.journal);
    expect(() => rig.engine.audit()).toThrow("Invalid quote replacement terms");
  } finally {
    rig.close();
  }
});
