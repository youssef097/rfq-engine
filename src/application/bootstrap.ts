/** Trusted, once-only fixture issuance; no account-opening or deposit API. */
import { hip4MarketId, validateHip4Binding } from "../integrations/hip4/index";
import {
  DomainError,
  MARKET_TERMS,
  arrayInput,
  boundedText,
  digest,
  encode,
  identifier,
  integer,
  money,
  objectInput,
} from "../domain/index";
import { fundFixture, type Store } from "../storage/index";
import type { MarketInput } from "../domain/types";

interface BootstrapHost {
  readonly store: Store;
  readonly clock: () => number;
  event: (
    now: number,
    kind: string,
    id: string,
    type: string,
    payload: unknown,
  ) => void;
}

export function bootstrapFixture(
  host: BootstrapHost,
  balances: Record<string, bigint>,
  markets: MarketInput[],
  operator: string,
): void {
  identifier(operator, "operator");
  if (
    balances === null ||
    typeof balances !== "object" ||
    Array.isArray(balances) ||
    Object.keys(balances).length > 1000
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Fixture balances must be a bounded dictionary",
    );
  objectInput(balances, Object.keys(balances));
  for (const [actor, amount] of Object.entries(balances)) {
    identifier(actor, "fixture actor");
    money(amount, "fixture balance");
  }
  arrayInput(markets, "Fixture markets", 1, 1000);
  const ids = new Set<string>();
  const terms = markets.map((raw) => {
    objectInput(
      raw,
      MARKET_TERMS,
      MARKET_TERMS.filter((field) => field !== "hip4"),
    );
    const item = {
      ...raw,
      hip4:
        !Object.hasOwn(raw, "hip4") || raw.hip4 === null
          ? null
          : validateHip4Binding(raw.hip4),
    };
    identifier(item.id, "market id");
    identifier(item.oracle, "oracle");
    identifier(item.arbiter, "arbiter");
    boundedText(item.description, "description");
    if (
      item.hip4 &&
      (item.id !== hip4MarketId(item.hip4) ||
        item.description !== (item.hip4.description || item.hip4.name))
    )
      throw new DomainError(
        "HIP4_TERMS_MISMATCH",
        "HIP-4 market identity and raw description must match its frozen binding",
      );
    for (const field of [
      "tradingClosesAt",
      "resolveAfter",
      "disputePeriod",
      "adjudicationPeriod",
      "fallbackAt",
    ] as const)
      integer(item[field], field, 1);
    if (
      !(
        item.tradingClosesAt <= item.resolveAfter &&
        item.resolveAfter + item.disputePeriod + item.adjudicationPeriod <=
          item.fallbackAt
      )
    )
      throw new DomainError("INVALID_INPUT", "Invalid resolution timetable");
    if (ids.has(item.id))
      throw new DomainError("INVALID_INPUT", "Duplicate fixture market");
    ids.add(item.id);
    return item;
  });
  host.store.transaction(() => {
    if (host.store.get("SELECT value FROM meta WHERE key='operator'"))
      throw new DomainError(
        "ALREADY_INITIALIZED",
        "Fixture issuance cannot be repeated",
      );
    const now = integer(host.clock(), "clock");
    if (terms.some((item) => item.tradingClosesAt <= now))
      throw new DomainError(
        "INVALID_INPUT",
        "Fixture markets must still be tradable",
      );
    host.store.run(
      "INSERT INTO meta(key,value) VALUES('operator',?)",
      operator,
    );
    host.store.run(
      "INSERT OR REPLACE INTO meta(key,value) VALUES('last_now',?)",
      String(now),
    );
    host.store.run(
      "INSERT OR IGNORE INTO meta(key,value) VALUES('total_funded','0')",
    );
    for (const [actor, amount] of Object.entries(balances))
      fundFixture(host.store, actor, amount);
    for (const item of terms) {
      host.store.run(
        "INSERT INTO markets(id,description,terms_hash,trading_closes_at,resolve_after,dispute_period,adjudication_period,fallback_at,oracle,arbiter,hip4_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        item.id,
        item.description,
        digest(item),
        item.tradingClosesAt,
        item.resolveAfter,
        item.disputePeriod,
        item.adjudicationPeriod,
        item.fallbackAt,
        item.oracle,
        item.arbiter,
        encode(item.hip4),
      );
      host.event(now, "market", item.id, "MARKET_CREATED", item);
    }
    host.event(now, "system", "fixture", "FIXTURE_FUNDED", balances);
  });
}
