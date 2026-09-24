import type {
  Leg,
  Market,
  PositionRow,
  Quote,
  RequestRow,
} from "../domain/types";

export interface JournalRow {
  source: string;
  destination: string;
  amount: bigint;
  reason: string;
  reference: string;
}
export type Commitment = (request: RequestRow, legs: Leg[]) => unknown;
export type TransferCounts = Map<string, number>;
export type ExpectTransfer = (
  source: string,
  destination: string,
  amount: bigint,
  reason: string,
  reference: string,
) => void;
export type Balances = ReadonlyMap<string, bigint>;

/** Indexed relations from one caller-held database snapshot. */
export interface Books {
  markets: ReadonlyMap<string, Market>;
  requests: ReadonlyMap<string, RequestRow>;
  quotes: ReadonlyMap<string, Quote>;
  positions: ReadonlyMap<string, PositionRow>;
  requestLegs: ReadonlyMap<string, Leg[]>;
  positionLegs: ReadonlyMap<string, Leg[]>;
  quotesByRequest: ReadonlyMap<string, Quote[]>;
}
