import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/index";
import { TestRig } from "../support/fixtures";
describe("RFQ validation", () => {
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

  test("money rejects numbers, unsafe numbers, strings, booleans and out-of-range bigints", () => {
    const invalid: unknown[] = [
      true,
      false,
      0n,
      -1n,
      1.5,
      100,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
      "100",
      9_000_000_000_000_001n,
    ];
    for (const stake of invalid) {
      const before = rig.engine.snapshot();
      expect(() => rig.request({ stake: stake as never })).toThrow(DomainError);
      expect(rig.engine.snapshot()).toEqual(before);
    }
  });

  test("invalid sides, leg shapes, duplicate outcomes and excess legs fail closed", () => {
    const invalid: unknown[] = [
      [],
      [{ marketId: "market_0", side: "MAYBE" }],
      [{ marketId: "market_0", side: true }],
      [{ marketId: "market_0" }],
      ["market_0"],
      [{ marketId: "unknown", side: "YES" }],
      [
        { marketId: "market_0", side: "YES" },
        { marketId: "market_0", side: "NO" },
      ],
      [{ marketId: "market_0", side: "YES", unexpected: 1 }],
      Array.from({ length: 9 }, (_, i) => ({
        marketId: `market_${i}`,
        side: "YES",
      })),
    ];
    for (const legs of invalid) {
      const before = rig.engine.snapshot();
      expect(() => rig.request({ legs: legs as never })).toThrow(DomainError);
      expect(rig.engine.snapshot()).toEqual(before);
    }
  });

  test("malformed deadlines reject bigint, unsafe number and invalid ordering", () => {
    for (const responseDeadline of [
      true,
      2_000n,
      "2000",
      1_000,
      1.1,
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        rig.request({ responseDeadline: responseDeadline as never }),
      ).toThrow(DomainError);
    }
    expect(() =>
      rig.request({ responseDeadline: 5_000, acceptanceDeadline: 2_000 }),
    ).toThrow(DomainError);
    expect(() => rig.request({ acceptanceDeadline: 10_001 })).toThrow(
      DomainError,
    );
  });

  test("malformed identifiers cannot access or create financial records", () => {
    for (const id of [
      "",
      "x".repeat(65),
      "../taker",
      "a b",
      "taker\n",
      "a\u0000b",
      123,
      true,
    ]) {
      expect(() => rig.request({ nonce: id as never })).toThrow(DomainError);
      expect(() => rig.engine.request(id as never)).toThrow(DomainError);
    }
    expect(() => rig.engine.request("missing")).toThrow(DomainError);
  });
});
