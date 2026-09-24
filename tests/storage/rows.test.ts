import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encode } from "../../src/domain/index";
import { Store } from "../../src/storage/index";
import { rejectsCode } from "./helpers";

describe("SQL row adaptation and immutable bindings", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    store.close();
  });

  test("normalizes SQL keys while preserving monetary bigint exactly", () => {
    const row = store.get<{
      amount: bigint;
      makerCollateral: bigint;
      priceE6: bigint;
      createdAt: number;
      sequence: number;
      halted: number;
    }>(
      "SELECT 9007199254740993 AS amount, 250 AS maker_collateral, 285714 AS price_e6, " +
        "253402300799999 AS created_at, 7 AS sequence, 0 AS halted",
    );
    expect(row).toEqual({
      amount: 9_007_199_254_740_993n,
      makerCollateral: 250n,
      priceE6: 285_714n,
      createdAt: 253_402_300_799_999,
      sequence: 7,
      halted: 0,
    });
    expect(store.get("SELECT 1 WHERE 0")).toBeUndefined();
  });

  test("rejects unsafe metadata narrowing and lossy numeric bindings", () => {
    rejectsCode(
      () => store.get("SELECT 9007199254740993 AS sequence"),
      "UNSAFE_INTEGER",
    );
    rejectsCode(
      () => store.get("SELECT ? AS sequence", Number.MAX_SAFE_INTEGER + 1),
      "UNSAFE_INTEGER",
    );
    rejectsCode(
      () => store.get("SELECT 1.5 AS amount"),
      "INVALID_STORAGE_VALUE",
    );
    rejectsCode(
      () => store.get("SELECT 1 AS created_at, 2 AS createdAt"),
      "INVALID_STORAGE_VALUE",
    );
  });

  test("HIP-4 SQL binding normalization uses the lossless tagged codec", () => {
    // This exercises the storage codec independently of the domain-specific
    // binding validator, which runs at the trusted market bootstrap boundary.
    const value = {
      identifier: "opaque codec fixture",
      nested: { integer: 9_007_199_254_740_993n, text: "9007199254740993" },
      flags: [true, false, null],
    };
    const row = store.get<{ hip4: typeof value }>(
      "SELECT ? AS hip4_json",
      encode(value),
    );
    expect(row).toEqual({ hip4: value });
    expect(row?.hip4.nested.integer).toBe(9_007_199_254_740_993n);
    expect(
      store.get<{ hip4: null }>("SELECT ? AS hip4_json", encode(null)),
    ).toEqual({
      hip4: null,
    });
    rejectsCode(
      () => store.get("SELECT NULL AS hip4_json"),
      "INVALID_STORAGE_VALUE",
    );
    rejectsCode(
      () => store.get("SELECT 'not tagged JSON' AS hip4_json"),
      "CORRUPT_RECEIPT",
    );
    rejectsCode(
      () => store.get("SELECT ? AS hip4_json, 1 AS hip4", encode(null)),
      "INVALID_STORAGE_VALUE",
    );
  });

  test("market HIP-4 binding defaults to tagged null and cannot change", () => {
    store.transaction(() => {
      store.run(
        "INSERT INTO markets(id,description,terms_hash,trading_closes_at,resolve_after," +
          "dispute_period,adjudication_period,fallback_at,oracle,arbiter) VALUES(?,?,?,?,?,?,?,?,?,?)",
        "market1",
        "Immutable test market",
        "terms",
        10_000,
        11_000,
        1_000,
        1_000,
        20_000,
        "oracle",
        "arbiter",
      );
    });
    expect(
      store.get<{ hip4: null }>(
        "SELECT hip4_json FROM markets WHERE id=?",
        "market1",
      ),
    ).toEqual({ hip4: null });
    expect(
      store.db.query("SELECT hip4_json FROM markets WHERE id=?").get("market1"),
    ).toEqual({ hip4_json: '["null"]' });
    expect(() =>
      store.transaction(() => {
        store.run(
          "UPDATE markets SET hip4_json=? WHERE id=?",
          encode({ changed: true }),
          "market1",
        );
      }),
    ).toThrow("immutable market terms");
    expect(
      store.get<{ hip4: null }>(
        "SELECT hip4_json FROM markets WHERE id=?",
        "market1",
      ),
    ).toEqual({ hip4: null });
  });
});
