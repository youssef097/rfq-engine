/** Typed reads. Multi-row callers hold the existing transaction snapshot. */
import { DomainError } from "../domain";
import type {
  Leg,
  Market,
  Quote,
  Position,
  PositionRow,
  RequestRecord,
  RequestRow,
} from "../domain/types";
import type { Store } from "./store";
interface TableRows {
  markets: Market;
  requests: RequestRow;
  quotes: Quote;
  positions: PositionRow;
}

export class Records {
  constructor(private readonly store: Store) {}
  require<K extends keyof TableRows>(table: K, id: string): TableRows[K] {
    const row = this.store.get<TableRows[K]>(
      `SELECT * FROM ${table} WHERE id=?`,
      id,
    );
    if (!row)
      throw new DomainError("NOT_FOUND", `Unknown ${table} identity: ${id}`);
    return row;
  }
  request(id: string): RequestRecord {
    return {
      ...this.require("requests", id),
      legs: this.store.all<Leg>(
        "SELECT * FROM request_legs WHERE request_id=? ORDER BY leg_index",
        id,
      ),
    };
  }
  position(id: string): Position {
    return {
      ...this.require("positions", id),
      legs: this.store.all<Leg>(
        "SELECT * FROM position_legs WHERE position_id=? ORDER BY leg_index",
        id,
      ),
    };
  }
}
