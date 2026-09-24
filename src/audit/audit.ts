import { invariant } from "../domain/index";
import type { Store } from "../storage/store";
import type { AuditReport } from "../domain/types";
import {
  checkTransferProvenance,
  countTransfer,
  reconcileLedger,
} from "./ledger-audit";
import { checkPositions, checkQuotes } from "./obligations";
import { checkMarketTerms, checkRequests, readBooks } from "./terms-audit";
import type { Commitment, ExpectTransfer } from "./types";

/** Caller holds one snapshot transaction; no phase mutates financial state. */
export function auditStore(
  store: Store,
  requestCommitment: Commitment,
): AuditReport {
  checkDatabase(store);
  const ledger = reconcileLedger(store);
  const books = readBooks(store);
  const expected = new Map<string, number>();
  const expectTransfer: ExpectTransfer = (
    source,
    destination,
    amount,
    reason,
    reference,
  ) =>
    countTransfer(expected, { source, destination, amount, reason, reference });

  checkMarketTerms(books.markets);
  checkRequests(books, requestCommitment);
  checkQuotes(books, ledger.balances, expectTransfer);
  checkPositions(books, ledger.balances, expectTransfer);
  checkTransferProvenance(ledger.transfers, expected);

  return {
    ok: true,
    totalFunded: ledger.total,
    requests: books.requests.size,
    quotes: books.quotes.size,
    positions: books.positions.size,
    journalEntries: ledger.journalEntries,
  };
}

function checkDatabase(store: Store): void {
  invariant(
    store.get<{ integrityCheck: string }>("PRAGMA integrity_check")
      ?.integrityCheck === "ok",
    "Database integrity",
  );
  invariant(
    store.all("PRAGMA foreign_key_check").length === 0,
    "Broken foreign key",
  );
}
