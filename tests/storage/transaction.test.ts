import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/index";
import {
  Store,
  available,
  balance,
  fundFixture,
  reserved,
  transfer,
} from "../../src/storage/index";
import { rejectsCode } from "./helpers";

describe("transaction rollback and asynchronous guards", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    store.close();
  });

  test("exceptions roll back funds and journal together", () => {
    store.transaction(() => fundFixture(store, "alice", 100n));
    expect(() =>
      store.transaction(() => {
        transfer(
          store,
          available("alice"),
          reserved("quote1"),
          100n,
          "reserve_quote",
          "quote1",
        );
        throw new Error("fault after transfer");
      }),
    ).toThrow("fault after transfer");
    expect(balance(store, available("alice"))).toBe(100n);
    expect(balance(store, reserved("quote1"))).toBe(0n);
    expect(
      store.get<{ count: number }>("SELECT count(*) AS count FROM journal")
        ?.count,
    ).toBe(1);
    expect(store.db.inTransaction).toBe(false);
  });

  test("nested transactions fail and roll back their enclosing transaction", () => {
    rejectsCode(
      () =>
        store.transaction(() => {
          fundFixture(store, "alice", 100n);
          store.transaction(() => fundFixture(store, "bob", 100n));
        }),
      "TRANSACTION_ACTIVE",
    );
    expect(balance(store, available("alice"))).toBe(0n);
    expect(store.db.inTransaction).toBe(false);
  });

  test("async callbacks are rejected before their body executes", () => {
    let ran = false;
    rejectsCode(
      () =>
        store.transaction(async () => {
          ran = true;
          fundFixture(store, "alice", 100n);
        }),
      "ASYNC_TRANSACTION",
    );
    expect(ran).toBe(false);
    expect(balance(store, available("alice"))).toBe(0n);
  });

  test("thenable returns roll back without invoking an arbitrary then method", () => {
    let invoked = false;
    rejectsCode(
      () =>
        store.transaction(() => {
          fundFixture(store, "alice", 100n);
          return {
            then: () => {
              invoked = true;
            },
          };
        }),
      "ASYNC_TRANSACTION",
    );
    expect(invoked).toBe(false);
    expect(balance(store, available("alice"))).toBe(0n);
    expect(store.db.inTransaction).toBe(false);
  });

  test("escaped Promise continuations cannot write after transaction rollback", async () => {
    let release: () => void = () => {
      throw new Error("Promise not initialized");
    };
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let escapedError: unknown;
    let continuation: Promise<void> | undefined;
    rejectsCode(
      () =>
        store.transaction(() => {
          fundFixture(store, "alice", 100n);
          continuation = (async () => {
            await paused;
            try {
              store.run(
                "INSERT INTO balances(account,amount) VALUES(?,?)",
                available("escaped"),
                1n,
              );
            } catch (error) {
              escapedError = error;
            }
          })();
          return continuation;
        }),
      "ASYNC_TRANSACTION",
    );
    release();
    await continuation;
    expect(escapedError).toBeInstanceOf(DomainError);
    expect((escapedError as DomainError).code).toBe("ASYNC_TRANSACTION");
    expect(balance(store, available("alice"))).toBe(0n);
    expect(balance(store, available("escaped"))).toBe(0n);
    store.transaction(() => fundFixture(store, "bob", 5n));
    expect(balance(store, available("bob"))).toBe(5n);
  });

  test("unreturned async work cannot reuse any store adapter after a successful commit", async () => {
    let continuation: Promise<void> | undefined;
    store.transaction(() => {
      fundFixture(store, "alice", 100n);
      // A synchronous callback can launch async work without returning its
      // Promise. The committed transaction's scope must still expire.
      continuation = Promise.resolve().then(() => {
        const operations = [
          () => store.get("SELECT * FROM balances"),
          () => store.all("SELECT * FROM balances"),
          () => store.run("UPDATE balances SET amount=0"),
          () => store.transaction(() => fundFixture(store, "escaped", 1n)),
          () => store.close(),
        ];
        for (const operation of operations)
          rejectsCode(operation, "ASYNC_TRANSACTION");
      });
    });
    await continuation;
    expect(store.db.inTransaction).toBe(false);
    expect(balance(store, available("alice"))).toBe(100n);
    expect(balance(store, available("escaped"))).toBe(0n);
    store.transaction(() => fundFixture(store, "bob", 5n));
    expect(balance(store, available("bob"))).toBe(5n);
  });
});
