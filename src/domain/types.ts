import type { Hip4Binding } from "./hip4-binding";
export type { Hip4Binding } from "./hip4-binding";

export type Side = "YES" | "NO";
export type Outcome = Side | "VOID";
export interface MarketInput {
  id: string;
  description: string;
  tradingClosesAt: number;
  resolveAfter: number;
  disputePeriod: number;
  adjudicationPeriod: number;
  fallbackAt: number;
  oracle: string;
  arbiter: string;
  hip4?: Hip4Binding | null;
}
export interface Market extends MarketInput {
  hip4: Hip4Binding | null;
  termsHash: string;
  halted: number;
  state: "UNRESOLVED" | "PROPOSED" | "DISPUTED" | "FINAL";
  proposedResult: Outcome | null;
  challengeDeadline: number | null;
  finalResult: Outcome | null;
  evidence: string | null;
}
export interface Selection {
  marketId: string;
  side: Side;
}
export interface Leg extends Selection {
  marketTermsHash: string;
  legIndex: number;
  requestId?: string;
  positionId?: string;
}
export type RequestState =
  | "COLLECTING"
  | "OFFERED"
  | "FILLED"
  | "SETTLED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED";
export interface RequestRow {
  id: string;
  taker: string;
  nonce: string;
  termsHash: string;
  stake: bigint;
  responseDeadline: number;
  acceptanceDeadline: number;
  state: RequestState;
  selectedQuoteId: string | null;
  createdAt: number;
  reason: string | null;
}
export interface RequestRecord extends RequestRow {
  legs: Leg[];
}
export type QuoteState =
  | "LIVE"
  | "SELECTED"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED";
export interface Quote {
  sequence: number;
  id: string;
  requestId: string;
  maker: string;
  requestHash: string;
  replacesQuoteId: string | null;
  payout: bigint;
  priceE6: bigint;
  expiresAt: number;
  state: QuoteState;
  createdAt: number;
}
export interface PositionRow {
  id: string;
  requestId: string;
  quoteId: string;
  taker: string;
  maker: string;
  stake: bigint;
  makerCollateral: bigint;
  payout: bigint;
  state: "OPEN" | "WON" | "LOST" | "VOID";
  createdAt: number;
  settledAt: number | null;
}
export interface Position extends PositionRow {
  legs: Leg[];
}
export interface AuditReport {
  ok: true;
  totalFunded: bigint;
  requests: number;
  quotes: number;
  positions: number;
  journalEntries: number;
}
export interface RecoveryResult {
  requests: number;
  quotes: number;
  markets: number;
  positions: number;
  hasMore: boolean;
}
