/** Public consistent reads and diagnostics; no financial transitions. */
import { identifier } from "../domain";
import type { RequestRecord, Quote, Position, Market } from "../domain/types";
import { available, balance, type Store } from "../storage/index";
import type { Records } from "../storage/records";
import { auditStore } from "../audit/audit";
import { requestCommitment } from "../rfq/commitment";
export class Queries {
  constructor(
    private readonly store: Store,
    private readonly records: Records,
  ) {}
  request(id: string): RequestRecord {
    identifier(id, "request id");
    return this.store.transaction(() => this.records.request(id));
  }
  quote(id: string): Quote {
    identifier(id, "quote id");
    return this.records.require("quotes", id);
  }
  position(id: string): Position {
    identifier(id, "position id");
    return this.store.transaction(() => this.records.position(id));
  }
  market(id: string): Market {
    identifier(id, "market id");
    return this.records.require("markets", id);
  }
  balance(actor: string): bigint {
    identifier(actor, "actor");
    return balance(this.store, available(actor));
  }
  snapshot(): Record<string, Record<string, unknown>[]> {
    return this.store.transaction(() =>
      Object.fromEntries(
        [
          "meta",
          "markets",
          "requests",
          "request_legs",
          "quotes",
          "positions",
          "position_legs",
          "balances",
          "journal",
          "commands",
          "events",
        ].map((table) => [
          table,
          this.store.all<Record<string, unknown>>(
            `SELECT * FROM ${table} ORDER BY rowid`,
          ),
        ]),
      ),
    );
  }
  audit() {
    return this.store.transaction(() =>
      auditStore(this.store, requestCommitment),
    );
  }
}
