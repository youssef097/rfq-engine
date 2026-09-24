/** Reconstruct balances and reconcile the exact historical transfer multiset. */
import { canonical, invariant } from "../domain/index";
import { available } from "../storage/ledger";
import type { Store } from "../storage/store";
import type { Balances, JournalRow, TransferCounts } from "./types";

export function countTransfer(counts: TransferCounts, row: JournalRow): void {
  // One transfer is bounded. Never serialize the entire growing database through
  // the command codec, whose node budget intentionally limits request payloads.
  const key = canonical([
    row.source,
    row.destination,
    row.amount,
    row.reason,
    row.reference,
  ]);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sameBalances(left: Balances, right: Balances): boolean {
  for (const [account, amount] of left)
    if (amount !== (right.get(account) ?? 0n)) return false;
  for (const [account, amount] of right)
    if (amount !== (left.get(account) ?? 0n)) return false;
  return true;
}

export function reconcileLedger(store: Store) {
  const reconstructed = new Map<string, bigint>();
  const transfers = new Map<string, number>();
  const journal = store.all<JournalRow>(
    "SELECT * FROM journal ORDER BY sequence",
  );
  let issued = 0n;
  for (const row of journal) {
    invariant(
      typeof row.amount === "bigint" && row.amount > 0n,
      "Invalid journal amount",
    );
    if (row.source === "EXTERNAL") {
      invariant(row.reason === "fixture_funding", "Unexpected external money");
      invariant(
        row.destination === available(row.reference),
        "Wrong fixture recipient",
      );
      issued += row.amount;
    } else {
      const remaining = (reconstructed.get(row.source) ?? 0n) - row.amount;
      reconstructed.set(row.source, remaining);
      invariant(remaining >= 0n, "Historical overdraft");
      countTransfer(transfers, row);
    }
    reconstructed.set(
      row.destination,
      (reconstructed.get(row.destination) ?? 0n) + row.amount,
    );
  }
  const balances = new Map(
    store
      .all<{ account: string; amount: bigint }>("SELECT * FROM balances")
      .map((row) => [row.account, row.amount]),
  );
  let balanceTotal = 0n;
  for (const amount of balances.values()) {
    invariant(typeof amount === "bigint" && amount >= 0n, "Invalid balance");
    balanceTotal += amount;
  }
  invariant(
    sameBalances(reconstructed, balances),
    "Journal/balance divergence",
  );
  const totalRow = store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key='total_funded'",
  );
  invariant(totalRow, "Missing fixture funding record");
  const total = BigInt(totalRow.value);
  invariant(
    issued === total && total === balanceTotal,
    "Money conservation failure",
  );
  return { balances, transfers, total, journalEntries: journal.length };
}

export function checkTransferProvenance(
  actual: TransferCounts,
  expected: TransferCounts,
): void {
  invariant(
    actual.size === expected.size &&
      [...expected].every(([key, count]) => actual.get(key) === count),
    "Unexpected transfer provenance",
  );
}
