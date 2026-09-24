import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TOTAL } from "../../src/domain/index";
import {
  Store,
  available,
  balance,
  diskJournalMode,
  fundFixture,
  transfer,
} from "../../src/storage/index";

describe("storage connections and journal policy", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    store.close();
  });

  test("WAL policy recognizes fixed release branches and fails closed on unknown versions", () => {
    const cases = [
      ["3.7.0", "delete"],
      ["3.44.5", "delete"],
      ["3.44.6", "wal"],
      ["3.44.7", "wal"],
      ["3.45.99", "delete"],
      ["3.49.7", "delete"],
      ["3.50.6", "delete"],
      ["3.50.7", "wal"],
      ["3.50.8", "wal"],
      ["3.51.0", "delete"],
      ["3.51.2", "delete"],
      ["3.51.3", "wal"],
      ["3.51.4", "wal"],
      ["3.52.0", "wal"],
      ["4.0.0", "wal"],
      ["", "delete"],
      ["unknown", "delete"],
      ["3.51", "delete"],
      ["3.51.3-custom", "delete"],
      ["3.051.3", "delete"],
      [" 3.51.3", "delete"],
      ["3.51.3\n", "delete"],
      ["3.51.3.1", "delete"],
      ["9007199254740993.0.0", "delete"],
    ] as const;
    for (const [version, expected] of cases)
      expect(diskJournalMode(version)).toBe(expected);
  });

  test("memory diagnostics report the actual SQLite runtime and journal mode", () => {
    expect(store.journalMode).toBe("memory");
    expect(
      store.get<{ version: string }>("SELECT sqlite_version() AS version")
        ?.version,
    ).toBe(store.sqliteVersion);
    expect(
      store.get<{ journalMode: string }>("PRAGMA journal_mode")?.journalMode,
    ).toBe(store.journalMode);
  });

  test("disk restart retains exact money and durable connection settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "rfq-storage-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const first = new Store(path);
      first.transaction(() => fundFixture(first, "alice", MAX_TOTAL));
      first.close();
      const second = new Store(path);
      try {
        expect(balance(second, available("alice"))).toBe(MAX_TOTAL);
        expect(
          second.get<{ journalMode: string }>("PRAGMA journal_mode")
            ?.journalMode,
        ).toBe(diskJournalMode(second.sqliteVersion));
        expect(second.journalMode).toBe(diskJournalMode(second.sqliteVersion));
        expect(
          second.get<{ synchronous: number }>("PRAGMA synchronous")
            ?.synchronous,
        ).toBe(2);
        expect(
          second.get<{ foreignKeys: number }>("PRAGMA foreign_keys")
            ?.foreignKeys,
        ).toBe(1);
        expect(
          second.get<{ recursiveTriggers: number }>("PRAGMA recursive_triggers")
            ?.recursiveTriggers,
        ).toBe(1);
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("opening a prior WAL database applies the safe policy and preserves existing data", () => {
    const directory = mkdtempSync(join(tmpdir(), "rfq-journal-policy-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const prior = new Database(path, { safeIntegers: true });
      try {
        expect(prior.query("PRAGMA journal_mode=WAL").get()).toEqual({
          journal_mode: "wal",
        });
        prior.exec("CREATE TABLE prior_data(value INTEGER NOT NULL)");
        prior.query("INSERT INTO prior_data VALUES(?)").run(MAX_TOTAL);
      } finally {
        prior.close();
      }
      const reopened = new Store(path);
      try {
        expect(reopened.journalMode).toBe(
          diskJournalMode(reopened.sqliteVersion),
        );
        expect(
          reopened.get<{ journalMode: string }>("PRAGMA journal_mode")
            ?.journalMode,
        ).toBe(reopened.journalMode);
        expect(
          reopened.get<{ amount: bigint }>(
            "SELECT value AS amount FROM prior_data",
          )?.amount,
        ).toBe(MAX_TOTAL);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("independent disk connections expose only committed funds under the selected journal", () => {
    const directory = mkdtempSync(join(tmpdir(), "rfq-journal-connections-"));
    const path = join(directory, "ledger.sqlite");
    let first: Store | undefined;
    let second: Store | undefined;
    try {
      first = new Store(path);
      second = new Store(path);
      const writer = first;
      const observer = second;
      expect(writer.journalMode).toBe(diskJournalMode(writer.sqliteVersion));
      expect(observer.journalMode).toBe(writer.journalMode);
      writer.transaction(() => {
        fundFixture(writer, "alice", 80n);
        expect(balance(observer, available("alice"))).toBe(0n);
      });
      expect(balance(observer, available("alice"))).toBe(80n);
      expect(() =>
        observer.transaction(() => {
          transfer(
            observer,
            available("alice"),
            available("bob"),
            30n,
            "test",
            "rollback",
          );
          expect(balance(writer, available("alice"))).toBe(80n);
          expect(balance(writer, available("bob"))).toBe(0n);
          throw new Error("rollback second connection");
        }),
      ).toThrow("rollback second connection");
      expect(balance(writer, available("alice"))).toBe(80n);
      expect(balance(observer, available("bob"))).toBe(0n);
      expect(
        writer.get<{ integrityCheck: string }>("PRAGMA integrity_check")
          ?.integrityCheck,
      ).toBe("ok");
    } finally {
      second?.close();
      first?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(["1", "bun-1", "bun-2", "bun-4", "missing"])(
    "rejects incompatible or missing schema %s without migrating it",
    (version) => {
      const directory = mkdtempSync(join(tmpdir(), "rfq-schema-"));
      const path = join(directory, "old.sqlite");
      try {
        const old = new Database(path);
        old.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)");
        if (version !== "missing")
          old.query("INSERT INTO meta VALUES('schema_version',?)").run(version);
        old.close();
        expect(() => new Store(path)).toThrow(
          "Unsupported or missing database schema version",
        );
        const check = new Database(path);
        try {
          expect(
            check
              .query("SELECT value FROM meta WHERE key='schema_version'")
              .get(),
          ).toEqual(version === "missing" ? null : { value: version });
          expect(
            check
              .query(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='markets'",
              )
              .get(),
          ).toBeNull();
        } finally {
          check.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
