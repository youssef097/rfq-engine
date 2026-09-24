import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_TOTAL } from "../../src/domain/index";
import {
  Store,
  available,
  balance,
  escrow,
  fundFixture,
  reserved,
  transfer,
} from "../../src/storage/index";
import { rejectsCode } from "./helpers";

describe("ledger balances and immutable history", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    store.close();
  });

  test("account namespaces and escaped identities cannot collide", () => {
    expect(available("a")).not.toBe(reserved("a"));
    expect(reserved("a")).not.toBe(escrow("a"));
    expect(available('a","b')).not.toBe(available('a"'));
  });

  test("fixture funding and transfers journal each movement once", () => {
    store.transaction(() => {
      fundFixture(store, "alice", 150n);
      fundFixture(store, "bob", 0n);
      transfer(
        store,
        available("alice"),
        reserved("quote1"),
        70n,
        "reserve_quote",
        "quote1",
      );
    });
    expect(balance(store, available("alice"))).toBe(80n);
    expect(balance(store, reserved("quote1"))).toBe(70n);
    expect(balance(store, available("bob"))).toBe(0n);
    expect(
      store.all(
        "SELECT source,destination,amount,reason,reference FROM journal ORDER BY sequence",
      ),
    ).toEqual([
      {
        source: "EXTERNAL",
        destination: available("alice"),
        amount: 150n,
        reason: "fixture_funding",
        reference: "alice",
      },
      {
        source: available("alice"),
        destination: reserved("quote1"),
        amount: 70n,
        reason: "reserve_quote",
        reference: "quote1",
      },
    ]);
    expect(
      store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='total_funded'",
      )?.value,
    ).toBe("150");
  });

  test("ledger writes require an explicit transaction", () => {
    rejectsCode(() => fundFixture(store, "alice", 10n), "TRANSACTION_REQUIRED");
    rejectsCode(
      () =>
        transfer(
          store,
          available("alice"),
          available("bob"),
          1n,
          "test",
          "test",
        ),
      "TRANSACTION_REQUIRED",
    );
    expect(
      store.get<{ count: number }>("SELECT count(*) AS count FROM journal")
        ?.count,
    ).toBe(0);
  });

  test("rejects boolean number string nonpositive and oversized transfer amounts", () => {
    store.transaction(() => fundFixture(store, "alice", 100n));
    const invalid: unknown[] = [
      true,
      false,
      1,
      1.5,
      "1",
      -1n,
      0n,
      MAX_TOTAL + 1n,
    ];
    for (const amount of invalid) {
      rejectsCode(
        () =>
          store.transaction(() =>
            transfer(
              store,
              available("alice"),
              available("bob"),
              amount as bigint,
              "test",
              "test",
            ),
          ),
        "INVALID_AMOUNT",
      );
      expect(balance(store, available("alice"))).toBe(100n);
      expect(balance(store, available("bob"))).toBe(0n);
    }
  });

  test("insufficient funding does not even create a destination", () => {
    store.transaction(() => {
      fundFixture(store, "alice", 10n);
      rejectsCode(
        () =>
          transfer(
            store,
            available("alice"),
            available("bob"),
            11n,
            "test",
            "test",
          ),
        "INSUFFICIENT_FUNDS",
      );
    });
    expect(
      store.get(
        "SELECT amount FROM balances WHERE account=?",
        available("bob"),
      ),
    ).toBeUndefined();
  });

  test("total funding bound rolls back the entire fixture transaction", () => {
    rejectsCode(
      () =>
        store.transaction(() => {
          fundFixture(store, "alice", MAX_TOTAL);
          fundFixture(store, "bob", 1n);
        }),
      "OVERFLOW",
    );
    expect(balance(store, available("alice"))).toBe(0n);
    expect(store.all("SELECT * FROM journal")).toEqual([]);
  });

  test("destination overflow fails before debit", () => {
    // Trusted diagnostic SQL deliberately bypasses backing to test the guard.
    store.transaction(() => {
      store.run("INSERT INTO balances VALUES(?,?)", available("alice"), 1n);
      store.run(
        "INSERT INTO balances VALUES(?,?)",
        available("bob"),
        MAX_TOTAL,
      );
      rejectsCode(
        () =>
          transfer(
            store,
            available("alice"),
            available("bob"),
            1n,
            "test",
            "test",
          ),
        "OVERFLOW",
      );
    });
    expect(balance(store, available("alice"))).toBe(1n);
    expect(balance(store, available("bob"))).toBe(MAX_TOTAL);
  });

  test("database checks reject negative real and oversized balances", () => {
    const beforeBalances = store.all("SELECT * FROM balances");
    const beforeJournal = store.all("SELECT * FROM journal");
    for (const amount of [-1n, 0.5, MAX_TOTAL + 1n]) {
      expect(() =>
        store.transaction(() => {
          // Exercise SQLite constraints directly, independently of the adapter.
          store.db
            .query("INSERT INTO balances VALUES(?,?)")
            .run(available("alice"), amount);
        }),
      ).toThrow("CHECK constraint failed");
      expect(store.all("SELECT * FROM balances")).toEqual(beforeBalances);
      expect(store.all("SELECT * FROM journal")).toEqual(beforeJournal);
    }
  });

  test("journal cannot be updated deleted or replaced", () => {
    store.transaction(() => fundFixture(store, "alice", 100n));
    for (const sql of [
      "UPDATE journal SET amount=99 WHERE sequence=1",
      "DELETE FROM journal WHERE sequence=1",
      "INSERT OR REPLACE INTO journal(sequence,source,destination,amount,reason,reference) " +
        "SELECT sequence,source,destination,99,reason,reference FROM journal WHERE sequence=1",
    ]) {
      expect(() => store.transaction(() => store.run(sql))).toThrow();
    }
    expect(
      store.get<{ amount: bigint }>("SELECT amount FROM journal")?.amount,
    ).toBe(100n);
  });

  test.each([
    [
      "commands",
      "INSERT INTO commands VALUES('alice','cmd1','hash','{}',1000)",
      "payload_hash",
    ],
    [
      "events",
      "INSERT INTO events VALUES(1,1000,'request','request1','created','{}')",
      "event_type",
    ],
  ])("%s cannot be updated deleted or replaced", (table, insert, column) => {
    store.transaction(() => store.run(insert));
    const before = store.all(`SELECT * FROM ${table}`);
    for (const sql of [
      `UPDATE ${table} SET ${column}='changed'`,
      `DELETE FROM ${table}`,
      insert.replace("INSERT INTO", "INSERT OR REPLACE INTO"),
    ]) {
      expect(() => store.transaction(() => store.run(sql))).toThrow();
      expect(store.all(`SELECT * FROM ${table}`)).toEqual(before);
      expect(store.db.inTransaction).toBe(false);
    }
  });
});
