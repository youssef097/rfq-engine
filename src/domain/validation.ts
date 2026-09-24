import { types } from "node:util";
import { DomainError } from "./errors";
import { MAX_TIMESTAMP, MAX_MONEY } from "./policy";

export function integer(
  value: unknown,
  name: string,
  min = 0,
  max = MAX_TIMESTAMP,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new DomainError(
      "INVALID_INPUT",
      `${name} must be a safe integer in [${min}, ${max}]`,
    );
  return value;
}

export function money(
  value: unknown,
  name: string,
  min = 0n,
  max = MAX_MONEY,
): bigint {
  if (typeof value !== "bigint" || value < min || value > max)
    throw new DomainError(
      "INVALID_INPUT",
      `${name} must be bigint in [${min}, ${max}]`,
    );
  return value;
}

export function identifier(value: unknown, name = "identifier"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value))
    throw new DomainError(
      "INVALID_INPUT",
      `${name} must be 1-64 ASCII identifier characters`,
    );
  return value;
}

export function boundedText(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new DomainError(
      "INVALID_INPUT",
      `${name} must contain 1-${max} characters`,
    );
  return value;
}

export function objectInput(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some(
      (k) => typeof k !== "string" || !allowed.includes(k),
    ) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Object has missing, unknown, or invalid fields",
    );
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor))
      throw new DomainError(
        "INVALID_INPUT",
        "Only enumerable data fields are accepted",
      );
  }
}

export function arrayInput(
  value: unknown,
  name: string,
  min = 0,
  max = 100_000,
): asserts value is unknown[] {
  if (
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < min ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new DomainError(
      "INVALID_INPUT",
      `${name} must be a dense array of ${min}-${max} items`,
    );
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new DomainError(
        "INVALID_INPUT",
        "Array items must be enumerable data fields",
      );
  }
}
