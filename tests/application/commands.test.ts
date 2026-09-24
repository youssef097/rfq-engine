import { describe, expect, test } from "bun:test";
import { DomainError, Engine, type CreateRequestArgs } from "../../src/index";
import { available, reserved, transfer } from "../../src/storage/index";
import { fixtureMarkets, initialBalances, TestRig } from "../support/fixtures";

function rejectsCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

function requestArgs(): CreateRequestArgs {
  return {
    nonce: "receipt_nonce",
    legs: [
      { marketId: "market_1", side: "NO" },
      { marketId: "market_0", side: "YES" },
    ],
    stake: 100_000_001n,
    responseDeadline: 2_000,
    acceptanceDeadline: 5_000,
  };
}

describe("shared command receipts through the public API", () => {
  test("restart replay returns original state before consulting a failed clock or commit hooks", () => {
    const rig = new TestRig();
    try {
      const args = requestArgs();
      const original = rig.engine.createRequest(
        "taker",
        "create_receipt",
        args,
      );
      rig.engine.cancelRequest("taker", "cancel_receipt", {
        requestId: original.id,
      });
      const before = rig.engine.snapshot();
      rig.engine.close();
      let clockReads = 0;
      let faultCalls = 0;
      rig.engine = new Engine({
        path: rig.path,
        clock: () => {
          clockReads += 1;
          throw new Error("clock unavailable");
        },
        fault: () => {
          faultCalls += 1;
          throw new Error("commit hook must not run for replay");
        },
      });

      const replay = rig.engine.createRequest("taker", "create_receipt", {
        ...args,
        legs: [...args.legs].reverse(),
      });
      expect(replay).toEqual(original);
      expect(replay.state).toBe("COLLECTING");
      expect(typeof replay.stake).toBe("bigint");
      expect(rig.engine.request(original.id).state).toBe("CANCELLED");
      rejectsCode(
        () =>
          rig.engine.createRequest("taker", "create_receipt", {
            ...args,
            stake: args.stake + 1n,
          }),
        "IDEMPOTENCY_CONFLICT",
      );
      expect(clockReads).toBe(0);
      expect(faultCalls).toBe(0);

      // Mutating a decoded receipt must not poison the next replay.
      replay.legs[0]!.side = "NO";
      replay.stake = 1n;
      expect(rig.engine.createRequest("taker", "create_receipt", args)).toEqual(
        original,
      );
      expect(() =>
        rig.engine.createRequest("taker", "fresh_command", {
          ...args,
          nonce: "fresh_nonce",
        }),
      ).toThrow("clock unavailable");
      expect(clockReads).toBe(1);
      expect(faultCalls).toBe(0);
      expect(rig.engine.snapshot()).toEqual(before);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("command IDs are actor-scoped but cannot be reused across feature operations", () => {
    const rig = new TestRig();
    try {
      const args = requestArgs();
      const first = rig.engine.createRequest("taker", "shared_id", args);
      const second = rig.engine.createRequest("other_taker", "shared_id", args);
      expect(first.id).not.toBe(second.id);
      expect(first.termsHash).not.toBe(second.termsHash);
      expect(first.taker).toBe("taker");
      expect(second.taker).toBe("other_taker");
      const before = rig.engine.snapshot();
      rejectsCode(
        () =>
          rig.engine.cancelRequest("taker", "shared_id", {
            requestId: first.id,
          }),
        "IDEMPOTENCY_CONFLICT",
      );
      rejectsCode(
        () => rig.engine.recover("taker", "shared_id"),
        "IDEMPOTENCY_CONFLICT",
      );
      expect(rig.engine.createRequest("taker", "shared_id", args)).toEqual(
        first,
      );
      expect(
        rig.engine.createRequest("other_taker", "shared_id", args),
      ).toEqual(second);
      expect(rig.engine.snapshot()).toEqual(before);
      expect(before.commands).toHaveLength(2);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("a command rejected before bootstrap leaves its ID available for a valid retry", () => {
    let clockReads = 0;
    const engine = new Engine({
      clock: () => {
        clockReads += 1;
        return 1_000;
      },
    });
    try {
      const before = engine.snapshot();
      const args = requestArgs();
      rejectsCode(
        () => engine.createRequest("taker", "after_bootstrap", args),
        "NOT_INITIALIZED",
      );
      expect(clockReads).toBe(0);
      expect(engine.snapshot()).toEqual(before);
      engine.bootstrap(initialBalances, fixtureMarkets());
      const result = engine.createRequest("taker", "after_bootstrap", args);
      expect(result.state).toBe("COLLECTING");
      expect(engine.snapshot().commands).toHaveLength(1);
      expect(engine.audit().ok).toBe(true);
    } finally {
      engine.close();
    }
  });
});

describe("synchronous command boundary", () => {
  test("invalid or repeated generated IDs roll back without consuming a request", () => {
    let nextId = "repeatable_id";
    const rig = new TestRig({ idFactory: () => nextId });
    try {
      rig.request();
      const before = rig.engine.snapshot();
      expect(() => rig.request()).toThrow();
      expect(rig.engine.snapshot()).toEqual(before);
      nextId = "invalid id with spaces";
      expect(() => rig.request()).toThrow(DomainError);
      expect(rig.engine.snapshot()).toEqual(before);
      nextId = "next_valid_id";
      expect(rig.request().id).toBe(nextId);
    } finally {
      rig.close();
    }
  });

  test("async action is rejected before its body can mutate or suspend", async () => {
    const rig = new TestRig();
    try {
      const before = rig.engine.snapshot();
      let ran = false;
      rejectsCode(
        () =>
          rig.engine.command(
            "taker",
            "async_command",
            { op: "test" },
            async () => {
              ran = true;
              transfer(
                rig.engine.store,
                available("taker"),
                reserved("escaped"),
                1n,
                "test",
                "escaped",
              );
              await Promise.resolve();
              return { state: "unexpected" };
            },
          ),
        "ASYNC_TRANSACTION",
      );
      await Promise.resolve();
      expect(ran).toBe(false);
      expect(rig.engine.snapshot()).toEqual(before);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("thenable result rolls back without invoking its then function", () => {
    const rig = new TestRig();
    try {
      const before = rig.engine.snapshot();
      let invoked = false;
      let actionRan = false;
      rejectsCode(
        () =>
          rig.engine.command(
            "taker",
            "thenable_command",
            { op: "test" },
            () => {
              actionRan = true;
              transfer(
                rig.engine.store,
                available("taker"),
                reserved("escaped"),
                1n,
                "test",
                "escaped",
              );
              return {
                then: () => {
                  invoked = true;
                },
              };
            },
          ),
        "ASYNC_TRANSACTION",
      );
      expect(actionRan).toBe(true);
      expect(invoked).toBe(false);
      expect(rig.engine.snapshot()).toEqual(before);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("escaped async continuation cannot write through store or a new command after rollback", async () => {
    const rig = new TestRig();
    try {
      const before = rig.engine.snapshot();
      let release = (): void => {
        throw new Error("Promise was not initialized");
      };
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      let continuation: Promise<void> | undefined;
      const failures: unknown[] = [];
      rejectsCode(
        () =>
          rig.engine.command("taker", "escaped_command", { op: "test" }, () => {
            transfer(
              rig.engine.store,
              available("taker"),
              reserved("escaped"),
              1n,
              "test",
              "escaped",
            );
            continuation = (async () => {
              await paused;
              try {
                rig.engine.store.run(
                  "UPDATE balances SET amount=amount+1 WHERE account=?",
                  available("taker"),
                );
              } catch (error) {
                failures.push(error);
              }
              try {
                rig.request({ nonce: "escaped_request" });
              } catch (error) {
                failures.push(error);
              }
            })();
            return continuation;
          }),
        "ASYNC_TRANSACTION",
      );
      release();
      await continuation;
      expect(failures).toHaveLength(2);
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(DomainError);
        expect((failure as DomainError).code).toBe("ASYNC_TRANSACTION");
      }
      expect(rig.engine.snapshot()).toEqual(before);
      expect(rig.request({ nonce: "normal_after_failure" }).state).toBe(
        "COLLECTING",
      );
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });
});
