/** One durable SQLite connection and its synchronous transaction boundary.
 * Independent Store instances coordinate through SQLite's writer lock.
 */
import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { DomainError } from "../domain/index";
import { diskJournalMode, type DiskJournalMode } from "./journal-mode";
import {
  normalizeRow,
  validateBindings,
  type RunResult,
  type SqlScalar,
} from "./rows";

export const SCHEMA_VERSION = "bun-3";
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

interface TransactionScope {
  active: boolean;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export class Store {
  readonly db: Database;
  readonly sqliteVersion: string;
  readonly journalMode: DiskJournalMode | "memory";
  private closed = false;
  private readonly scope = new AsyncLocalStorage<TransactionScope>();

  constructor(path = ":memory:") {
    this.db = new Database(path, { strict: true, safeIntegers: true });
    try {
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 10000");
      this.db.exec("PRAGMA recursive_triggers = ON");
      const version = this.get<{ sqliteVersion: string }>(
        "SELECT sqlite_version() AS sqlite_version",
      )?.sqliteVersion;
      if (typeof version !== "string")
        throw new Error("Unable to determine the active SQLite version");
      this.sqliteVersion = version;
      const requestedMode =
        path === ":memory:" ? "memory" : diskJournalMode(version);
      const actualMode = this.get<{ journalMode: string }>(
        path === ":memory:"
          ? "PRAGMA journal_mode"
          : `PRAGMA journal_mode = ${requestedMode}`,
      )?.journalMode;
      if (actualMode !== requestedMode)
        throw new Error(`Database must support ${requestedMode} journaling`);
      this.journalMode = requestedMode;
      this.db.exec("PRAGMA synchronous = FULL");
      this.transaction(() => {
        const existing = this.get<{ present: number }>(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='meta'",
        );
        if (existing) {
          const version = this.get<{ value: string }>(
            "SELECT value FROM meta WHERE key='schema_version'",
          );
          if (version?.value !== SCHEMA_VERSION) {
            throw new Error("Unsupported or missing database schema version");
          }
        }
        this.db.exec(schema);
        this.run(
          "INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version',?)",
          SCHEMA_VERSION,
        );
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new DomainError("STORE_CLOSED", "The SQLite store is closed");
    }
    const scope = this.scope.getStore();
    if (scope && !scope.active) {
      throw new DomainError(
        "ASYNC_TRANSACTION",
        "An asynchronous continuation escaped its transaction",
      );
    }
  }

  get<T>(sql: string, ...parameters: SqlScalar[]): T | undefined {
    this.assertUsable();
    validateBindings(parameters);
    const row: unknown = this.db.query(sql).get(...parameters);
    return row === null || row === undefined ? undefined : normalizeRow<T>(row);
  }

  all<T>(sql: string, ...parameters: SqlScalar[]): T[] {
    this.assertUsable();
    validateBindings(parameters);
    return this.db
      .query(sql)
      .all(...parameters)
      .map((row) => normalizeRow<T>(row));
  }

  run(sql: string, ...parameters: SqlScalar[]): RunResult {
    this.assertUsable();
    validateBindings(parameters);
    return this.db.query(sql).run(...parameters);
  }

  transaction<T>(action: () => T): T {
    this.assertUsable();
    if (typeof action !== "function") {
      throw new DomainError(
        "INVALID_TRANSACTION",
        "A transaction requires a synchronous callback",
      );
    }
    if (Object.prototype.toString.call(action) === "[object AsyncFunction]") {
      throw new DomainError(
        "ASYNC_TRANSACTION",
        "Async transaction callbacks are not supported",
      );
    }
    if (this.db.inTransaction) {
      throw new DomainError(
        "TRANSACTION_ACTIVE",
        "Nested transactions are not supported",
      );
    }
    const scope: TransactionScope = { active: true };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.scope.run(scope, action);
      if (isThenable(result)) {
        // An async helper may already be suspended. Its continuation retains
        // the scope token and cannot subsequently use this Store's adapters.
        // Observe native Promise rejections without attempting to run arbitrary
        // thenables; synchronous callers receive the error immediately.
        if (result instanceof Promise) void result.catch(() => undefined);
        throw new DomainError(
          "ASYNC_TRANSACTION",
          "A transaction callback returned a thenable",
        );
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      scope.active = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.assertUsable();
    if (this.db.inTransaction) {
      throw new DomainError(
        "TRANSACTION_ACTIVE",
        "Close the store after its transaction completes",
      );
    }
    this.db.close();
    this.closed = true;
  }
}
