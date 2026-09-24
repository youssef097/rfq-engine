import type { Selection } from "../domain/types";

export interface CreateRequestArgs {
  nonce: string;
  legs: Selection[];
  stake: bigint;
  responseDeadline: number;
  acceptanceDeadline: number;
}
export interface SubmitQuoteArgs {
  requestId: string;
  requestHash: string;
  payout: bigint;
  priceE6: bigint;
  expiresAt: number;
}
export interface RequestArgs {
  requestId: string;
}
export interface AcceptArgs extends RequestArgs {
  quoteId: string;
}
