import { DomainError, objectInput } from "../domain/index";
import type { ResolutionResult } from "./types";

export function result(value: unknown): ResolutionResult {
  if (value !== "YES" && value !== "NO" && value !== "VOID") {
    throw new DomainError("INVALID_INPUT", "result must be YES, NO, or VOID");
  }
  return value;
}

/** Bound and validate raw inputs before the host hashes or stores the payload. */
export function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  objectInput(value, keys);
  return value;
}
