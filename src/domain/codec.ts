import { createHash } from "node:crypto";
import { types } from "node:util";
import { DomainError } from "./errors";
import { arrayInput, objectInput } from "./validation";

// A fully tagged tree avoids collisions between bigint, decimal strings, and numbers.
// This is a LOCAL commitment/receipt codec, not EIP-712 or a wire authorization.
type Packed =
  | ["null"]
  | ["boolean", boolean]
  | ["number", number]
  | ["string", string]
  | ["bigint", string]
  | ["array", Packed[]]
  | ["object", [string, Packed][]];

function pack(
  value: unknown,
  seen: Set<object>,
  depth: number,
  budget: { n: number },
): Packed {
  if (depth > 32 || ++budget.n > 100_000)
    throw new DomainError("INVALID_INPUT", "Value exceeds codec limits");
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new DomainError(
        "INVALID_INPUT",
        "Only safe integer numbers are supported",
      );
    return ["number", Object.is(value, -0) ? 0 : value];
  }
  // Proxies can change a field between validation, hashing, and execution.
  // Reject them before invoking any reflection trap, including ownKeys.
  if (typeof value !== "object" || types.isProxy(value) || seen.has(value))
    throw new DomainError("INVALID_INPUT", "Unsupported or cyclic value");
  seen.add(value);
  let result: Packed;
  if (Array.isArray(value)) {
    arrayInput(value, "Encoded array");
    result = ["array", value.map((v) => pack(v, seen, depth + 1, budget))];
  } else {
    objectInput(value, Object.keys(value));
    result = [
      "object",
      Object.keys(value)
        .sort()
        .map((k) => [k, pack(value[k], seen, depth + 1, budget)]),
    ];
  }
  seen.delete(value);
  return result;
}

export function canonical(value: unknown): string {
  return JSON.stringify(pack(value, new Set(), 0, { n: 0 }));
}
export const encode = canonical;
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function decode<T>(text: string): T {
  let nodes = 0;
  function unpack(value: unknown, depth: number): unknown {
    if (depth > 32 || ++nodes > 100_000 || !Array.isArray(value))
      throw new DomainError("CORRUPT_RECEIPT", "Invalid receipt encoding");
    const [tag, data] = value;
    if (tag === "null" && value.length === 1) return null;
    if (value.length === 2) {
      if (tag === "boolean" && typeof data === "boolean") return data;
      if (tag === "string" && typeof data === "string") return data;
      if (
        tag === "number" &&
        typeof data === "number" &&
        Number.isSafeInteger(data)
      )
        return data;
      if (
        tag === "bigint" &&
        typeof data === "string" &&
        /^(0|-?[1-9][0-9]*)$/.test(data)
      )
        return BigInt(data);
      if (tag === "array" && Array.isArray(data))
        return data.map((v) => unpack(v, depth + 1));
      if (tag === "object" && Array.isArray(data)) {
        const keys = new Set<string>();
        return Object.fromEntries(
          data.map((entry) => {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== "string" ||
              keys.has(entry[0])
            )
              throw new DomainError(
                "CORRUPT_RECEIPT",
                "Invalid receipt object",
              );
            keys.add(entry[0]);
            return [entry[0], unpack(entry[1], depth + 1)];
          }),
        );
      }
    }
    throw new DomainError("CORRUPT_RECEIPT", "Invalid receipt encoding");
  }
  try {
    return unpack(JSON.parse(text) as unknown, 0) as T;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("CORRUPT_RECEIPT", "Unreadable receipt");
  }
}
