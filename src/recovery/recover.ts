/** Fair, bounded recovery inside the caller's existing command transaction. */
import { DomainError, integer, invariant } from "../domain/index";
import type { SqlScalar, Store } from "../storage/index";
import type { RecoveryResult } from "../domain/types";

interface RecoveryHost {
  readonly store: Store;
  refreshRequest(id: string, now: number): void;
  expireQuote(id: string, now: number): void;
  finalizeMarket(id: string, now: number): void;
  settlePosition(id: string, now: number): void;
}

type QueueKind = Exclude<keyof RecoveryResult, "hasMore">;

interface RecoveryQueue {
  readonly kind: QueueKind;
  readonly sql: string;
  readonly parameters: readonly SqlScalar[];
  readonly process: (id: string) => void;
}

// Every candidate has the same actual shape. Domain handlers read their own
// complete records while the same writer lock remains held.
interface Candidate {
  id: string;
}

const invalidRequest = `
  SELECT r.id
  FROM requests r
  WHERE r.state IN ('COLLECTING', 'OFFERED')
    AND (
      r.acceptance_deadline <= ?
      OR EXISTS (
        SELECT 1 FROM quotes q
        WHERE q.id = r.selected_quote_id AND q.expires_at <= ?
      )
      OR EXISTS (
        SELECT 1
        FROM request_legs l
        JOIN markets m ON m.id = l.market_id
        WHERE l.request_id = r.id
          AND (
            m.halted = 1
            OR m.state != 'UNRESOLVED'
            OR m.trading_closes_at <= ?
            OR m.terms_hash != l.market_terms_hash
          )
      )
    )
  ORDER BY r.created_at, r.id
  LIMIT 1
`;

const expiredQuote = `
  SELECT id
  FROM quotes
  WHERE state = 'LIVE' AND expires_at <= ?
  ORDER BY expires_at, sequence
  LIMIT 1
`;

const finalizableMarket = `
  SELECT id
  FROM markets
  WHERE state != 'FINAL'
    AND (
      fallback_at <= ?
      OR (state = 'PROPOSED' AND challenge_deadline <= ?)
    )
  ORDER BY fallback_at, id
  LIMIT 1
`;

const settleablePosition = `
  SELECT p.id
  FROM positions p
  WHERE p.state = 'OPEN'
    AND NOT EXISTS (
      SELECT 1
      FROM position_legs l
      JOIN markets m ON m.id = l.market_id
      WHERE l.position_id = p.id AND m.state != 'FINAL'
    )
  ORDER BY p.created_at, p.id
  LIMIT 1
`;

export function runRecovery(
  host: RecoveryHost,
  now: number,
  limit: number,
): RecoveryResult {
  const { store } = host;
  if (!store.db.inTransaction) {
    throw new DomainError(
      "TRANSACTION_REQUIRED",
      "Recovery requires the caller's command transaction",
    );
  }
  const queues: readonly RecoveryQueue[] = [
    {
      kind: "requests",
      sql: invalidRequest,
      parameters: [now, now, now],
      process: (id) => host.refreshRequest(id, now),
    },
    {
      kind: "quotes",
      sql: expiredQuote,
      parameters: [now],
      process: (id) => host.expireQuote(id, now),
    },
    {
      kind: "markets",
      sql: finalizableMarket,
      parameters: [now, now],
      process: (id) => host.finalizeMarket(id, now),
    },
    {
      kind: "positions",
      sql: settleablePosition,
      parameters: [],
      process: (id) => host.settlePosition(id, now),
    },
  ];
  const next = (queue: RecoveryQueue): Candidate | undefined =>
    store.get<Candidate>(queue.sql, ...queue.parameters);
  const counts: Record<QueueKind, number> = {
    requests: 0,
    quotes: 0,
    markets: 0,
    positions: 0,
  };
  let cursor = Number(
    store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'recovery_cursor'",
    )?.value ?? "0",
  );
  integer(cursor, "recovery cursor", 0, queues.length - 1);

  for (let processed = 0; processed < limit; processed++) {
    let found = false;
    for (let offset = 0; offset < queues.length; offset++) {
      const index = (cursor + offset) % queues.length;
      const queue = queues[index];
      invariant(queue, "Recovery cursor must identify a queue");
      const candidate = next(queue);
      if (!candidate) continue;
      queue.process(candidate.id);
      counts[queue.kind]++;
      cursor = (index + 1) % queues.length;
      found = true;
      break;
    }
    if (!found) break;
  }

  // Cursor, financial changes, and receipt share one commit. A failed batch
  // cannot persist a cursor that skips work rolled back with the transaction.
  store.run(
    `INSERT INTO meta(key, value) VALUES('recovery_cursor', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(cursor),
  );
  return {
    ...counts,
    hasMore: queues.some((queue) => next(queue) !== undefined),
  };
}
