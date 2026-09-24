/** Adapt SQLite scalars without losing money or accepting ambiguous columns. */
import { decode, DomainError } from "../domain/index";
import type { Hip4Binding } from "../domain/types";

export type SqlScalar = string | number | bigint | null | Uint8Array;
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

const monetaryColumns = new Set([
  "stake",
  "payout",
  "maker_collateral",
  "makerCollateral",
  "amount",
  "price_e6",
  "priceE6",
]);

function camelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase(),
  );
}

/** SQLite safeIntegers returns every INTEGER as bigint. Only metadata is narrowed. */
export function normalizeRow<T>(row: unknown): T {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new DomainError(
      "INVALID_STORAGE_VALUE",
      "Expected a SQLite result row",
    );
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    let converted = value;
    if (key === "hip4_json") {
      if (typeof value !== "string") {
        throw new DomainError(
          "INVALID_STORAGE_VALUE",
          "HIP-4 bindings must use the tagged text encoding",
        );
      }
      converted = decode<Hip4Binding | null>(value);
    } else if (monetaryColumns.has(key)) {
      if (value !== null && typeof value !== "bigint") {
        throw new DomainError(
          "INVALID_STORAGE_VALUE",
          "Monetary SQL results must be INTEGER bigint values",
        );
      }
    } else if (typeof value === "bigint") {
      const narrowed = Number(value);
      if (!Number.isSafeInteger(narrowed)) {
        throw new DomainError(
          "UNSAFE_INTEGER",
          `SQL metadata column ${key} exceeds the safe integer range`,
        );
      }
      converted = narrowed;
    }
    const name = key === "hip4_json" ? "hip4" : camelCase(key);
    if (Object.hasOwn(normalized, name)) {
      throw new DomainError(
        "INVALID_STORAGE_VALUE",
        "SQL aliases collide after key normalization",
      );
    }
    Object.defineProperty(normalized, name, {
      value: converted,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  // SQL result types are asserted by the internal caller, after runtime scalar
  // normalization. No untrusted payload is cast into a domain object here.
  return normalized as T;
}

export function validateBindings(parameters: SqlScalar[]): void {
  for (const value of parameters) {
    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      ) {
        throw new DomainError(
          "UNSAFE_INTEGER",
          "SQL numeric parameters cannot lose integer precision",
        );
      }
    } else if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "bigint" &&
      !(value instanceof Uint8Array)
    ) {
      throw new DomainError(
        "INVALID_SQL_BIND",
        "SQL parameters must be scalar values",
      );
    }
  }
}
