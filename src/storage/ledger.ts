/** Integer-only movements among available funds, quote reservations and escrow.
 * Every mutation belongs to the caller's existing Store transaction.
 */
import { DomainError, MAX_TOTAL } from "../domain/index";
import type { Store } from "./store";

function account(kind: string, identity: string): string {
  if (
    typeof identity !== "string" ||
    identity.length === 0 ||
    identity.length > 256
  ) {
    throw new DomainError(
      "INVALID_ACCOUNT",
      "Account identity must be a bounded nonempty string",
    );
  }
  return JSON.stringify([kind, identity]);
}

export function available(actor: string): string {
  return account("available", actor);
}

export function reserved(quoteId: string): string {
  return account("reserved", quoteId);
}

export function escrow(positionId: string): string {
  return account("escrow", positionId);
}

function validateAccount(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value === "EXTERNAL"
  ) {
    throw new DomainError("INVALID_ACCOUNT", "Invalid ledger account");
  }
}

function validateAmount(value: bigint, allowZero = false): void {
  const minimum = allowZero ? 0n : 1n;
  if (typeof value !== "bigint" || value < minimum || value > MAX_TOTAL) {
    throw new DomainError(
      "INVALID_AMOUNT",
      `Amount must be bigint between ${minimum} and ${MAX_TOTAL}`,
    );
  }
}

function requireTransaction(store: Store): void {
  if (!store.db.inTransaction) {
    throw new DomainError(
      "TRANSACTION_REQUIRED",
      "Ledger mutations require a transaction",
    );
  }
}

export function balance(store: Store, name: string): bigint {
  validateAccount(name);
  return (
    store.get<{ amount: bigint }>(
      "SELECT amount FROM balances WHERE account=?",
      name,
    )?.amount ?? 0n
  );
}

/** Move backed funds and append exactly one journal row in the caller's transaction. */
export function transfer(
  store: Store,
  source: string,
  destination: string,
  amount: bigint,
  reason: string,
  reference: string,
): void {
  requireTransaction(store);
  validateAccount(source);
  validateAccount(destination);
  validateAmount(amount);
  if (source === destination) {
    throw new DomainError(
      "INVALID_TRANSFER",
      "Source and destination must differ",
    );
  }
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > 256
  ) {
    throw new DomainError(
      "INVALID_TRANSFER",
      "Reason must be a bounded nonempty string",
    );
  }
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.length > 256
  ) {
    throw new DomainError(
      "INVALID_TRANSFER",
      "Reference must be a bounded nonempty string",
    );
  }
  if (balance(store, source) < amount) {
    throw new DomainError(
      "INSUFFICIENT_FUNDS",
      "Source account lacks sufficient available funds",
    );
  }
  if (balance(store, destination) > MAX_TOTAL - amount) {
    throw new DomainError(
      "OVERFLOW",
      "Destination balance exceeds the supported bound",
    );
  }
  const debited = store.run(
    "UPDATE balances SET amount=amount-? WHERE account=? AND amount>=?",
    amount,
    source,
    amount,
  );
  if (debited.changes !== 1 && debited.changes !== 1n) {
    throw new DomainError(
      "INSUFFICIENT_FUNDS",
      "Source account lacks sufficient available funds",
    );
  }
  store.run(
    "INSERT OR IGNORE INTO balances(account,amount) VALUES(?,0)",
    destination,
  );
  store.run(
    "UPDATE balances SET amount=amount+? WHERE account=?",
    amount,
    destination,
  );
  store.run(
    "INSERT INTO journal(source,destination,amount,reason,reference) VALUES(?,?,?,?,?)",
    source,
    destination,
    amount,
    reason,
    reference,
  );
}

/** Bootstrap-only external backing, capped across the entire mock system. */
export function fundFixture(store: Store, actor: string, amount: bigint): void {
  requireTransaction(store);
  validateAmount(amount, true);
  const destination = available(actor);
  const stored = store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key='total_funded'",
  );
  if (stored && !/^(0|[1-9][0-9]*)$/.test(stored.value)) {
    throw new DomainError(
      "CORRUPT_BACKING",
      "Fixture funding metadata is not a decimal integer",
    );
  }
  const total = stored ? BigInt(stored.value) : 0n;
  if (total > MAX_TOTAL || total > MAX_TOTAL - amount) {
    throw new DomainError(
      "OVERFLOW",
      "Total fixture funding exceeds the supported bound",
    );
  }
  if (balance(store, destination) > MAX_TOTAL - amount) {
    throw new DomainError(
      "OVERFLOW",
      "Fixture account exceeds the supported bound",
    );
  }
  store.run(
    "INSERT OR IGNORE INTO balances(account,amount) VALUES(?,0)",
    destination,
  );
  if (amount > 0n) {
    store.run(
      "UPDATE balances SET amount=amount+? WHERE account=?",
      amount,
      destination,
    );
    store.run(
      "INSERT INTO journal(source,destination,amount,reason,reference) VALUES('EXTERNAL',?,?,'fixture_funding',?)",
      destination,
      amount,
      actor,
    );
  }
  store.run(
    "INSERT INTO meta(key,value) VALUES('total_funded',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    (total + amount).toString(),
  );
}
