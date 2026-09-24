/** Exact amount/fraction conversion; never infer native lot sizes. */
import { DomainError, integer } from "../../domain";
const MAX_DECIMAL_TEXT = 128;
export function decimalParts(value: unknown): {
  whole: string;
  fraction: string;
} {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DECIMAL_TEXT ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      "Expected a nonnegative plain decimal string of at most 128 characters",
    );
  }
  const separator = value.indexOf(".");
  return separator === -1
    ? { whole: value, fraction: "" }
    : {
        whole: value.slice(0, separator),
        fraction: value.slice(separator + 1),
      };
}

function precision(value: number): number {
  return integer(value, "Decimal precision", 0, 18);
}

function unsignedAmount(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new DomainError(
      "INVALID_INPUT",
      "Amount must be a nonnegative bigint",
    );
  }
  return value;
}

/** Extra fractional zeroes are exact; nonzero discarded digits are never rounded. */
export function parseDecimalUnits(value: unknown, decimals: number): bigint {
  const places = precision(decimals);
  const { whole, fraction } = decimalParts(value);
  if (/[1-9]/.test(fraction.slice(places))) {
    throw new DomainError(
      "PRECISION_LOSS",
      "Decimal amount cannot be represented exactly at the requested precision",
    );
  }
  const retained = fraction.slice(0, places).padEnd(places, "0");
  return (
    BigInt(whole) * 10n ** BigInt(places) + (retained ? BigInt(retained) : 0n)
  );
}

/** Minimal plain decimal text, with no exponent or insignificant trailing zeroes. */
export function formatDecimalUnits(amount: bigint, decimals: number): string {
  unsignedAmount(amount);
  const places = precision(decimals);
  if (places === 0) return amount.toString();
  const padded = amount.toString().padStart(places + 1, "0");
  const whole = padded.slice(0, -places);
  const fraction = padded.slice(-places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Convert local representations without silently dropping a single base unit. */
export function convertUnitsExact(
  amount: bigint,
  from: number,
  to: number,
): bigint {
  unsignedAmount(amount);
  const source = precision(from);
  const destination = precision(to);
  if (destination >= source)
    return amount * 10n ** BigInt(destination - source);
  const divisor = 10n ** BigInt(source - destination);
  if (amount % divisor !== 0n)
    throw new DomainError(
      "PRECISION_LOSS",
      "Unit conversion would discard nonzero dust",
    );
  return amount / divisor;
}

/** Existing parlay settlement supports binary finality, not fractional redemption. */
export function binaryResultFromFraction(value: unknown): "YES" | "NO" {
  const { whole, fraction } = decimalParts(value);
  const integerPart = BigInt(whole);
  const hasFraction = /[1-9]/.test(fraction);
  if (integerPart > 1n || (integerPart === 1n && hasFraction)) {
    throw new DomainError(
      "INVALID_INPUT",
      "Settlement fraction must be in [0, 1]",
    );
  }
  if (integerPart === 0n && hasFraction) {
    throw new DomainError(
      "FRACTIONAL_OUTCOME_UNSUPPORTED",
      "Fractional HIP-4 redemption cannot be treated as a binary result or an original-stake refund",
    );
  }
  return integerPart === 1n ? "YES" : "NO";
}
