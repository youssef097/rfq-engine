import { DomainError } from "../domain/index";
import type { ResolutionResult } from "./types";

export function result(value: unknown): ResolutionResult {
  if (value !== "YES" && value !== "NO" && value !== "VOID") {
    throw new DomainError("INVALID_INPUT", "result must be YES, NO, or VOID");
  }
  return value;
}
