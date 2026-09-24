export const UNIT = 1_000_000n;
export const MAX_MONEY = 1_000_000_000_000_000n;
export const MAX_TOTAL = 9_000_000_000_000_000n;
export const MAX_TIMESTAMP = 253_402_300_799_999;
export const MAX_LEGS = 8;
export const MAX_QUOTES = 32;
export const MAX_OPEN_REQUESTS = 32;
export const POLICY =
  "parlay-v3:usdc6:zero-fees:all-final:loss-before-void:original-refunds:hip4-binary-only:fixed-adjudication-buffer:firm-competitive-admission";
export const MARKET_TERMS = [
  "id",
  "description",
  "tradingClosesAt",
  "resolveAfter",
  "disputePeriod",
  "adjudicationPeriod",
  "fallbackAt",
  "oracle",
  "arbiter",
  "hip4",
] as const;
