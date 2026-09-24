import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  type CreateRequestArgs,
  type SubmitQuoteArgs,
} from "../../src/engine";
import { ManualClock, quotePrice } from "../../src/domain/index";
import type { MarketInput, Quote, RequestRecord } from "../../src/domain/types";

export const initialBalances = {
  taker: 1_000_000_000n,
  other_taker: 1_000_000_000n,
  maker_a: 2_000_000_000n,
  maker_b: 2_000_000_000n,
  maker_c: 2_000_000_000n,
  poor_maker: 100_000_000n,
};

export function fixtureMarkets(scale = 1): MarketInput[] {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `market_${index}`,
    description: `Deterministic test outcome ${index}`,
    tradingClosesAt: 10_000 * scale,
    resolveAfter: 11_000 * scale,
    disputePeriod: 1_000 * scale,
    adjudicationPeriod: 1_000 * scale,
    fallbackAt: 20_000 * scale,
    oracle: "oracle",
    arbiter: "arbiter",
  }));
}

export class TestRig {
  readonly directory: string;
  readonly path: string;
  readonly clock: ManualClock;
  engine: Engine;
  faultStage: string | null = null;
  private serial = 0;
  private readonly idFactory?: () => string;

  constructor(
    options: {
      balances?: Record<string, bigint>;
      markets?: MarketInput[];
      now?: number;
      idFactory?: () => string;
    } = {},
  ) {
    this.directory = mkdtempSync(join(tmpdir(), "rfq-bun-test-"));
    this.path = join(this.directory, "engine.sqlite3");
    this.clock = new ManualClock(options.now ?? 1_000);
    this.idFactory = options.idFactory;
    this.engine = this.open();
    this.engine.bootstrap(
      options.balances ?? initialBalances,
      options.markets ?? fixtureMarkets(),
    );
  }

  private open(): Engine {
    return new Engine({
      path: this.path,
      clock: this.clock.now,
      idFactory: this.idFactory,
      fault: (stage) => {
        if (stage === this.faultStage)
          throw new Error(`injected failure: ${stage}`);
      },
    });
  }

  reopen(): void {
    this.engine.close();
    this.engine = this.open();
  }

  close(): void {
    this.engine.close();
    rmSync(this.directory, { recursive: true, force: true });
  }

  command(): string {
    this.serial += 1;
    return `command_${this.serial}`;
  }

  request(
    overrides: Partial<CreateRequestArgs> = {},
    actor = "taker",
  ): RequestRecord {
    const command = this.command();
    return this.engine.createRequest(actor, command, {
      nonce: `nonce_${command}`,
      legs: [
        { marketId: "market_0", side: "YES" },
        { marketId: "market_1", side: "NO" },
        { marketId: "market_2", side: "YES" },
      ],
      stake: 100_000_000n,
      responseDeadline: 2_000,
      acceptanceDeadline: 5_000,
      ...overrides,
    });
  }

  quote(
    request: RequestRecord,
    overrides: Partial<SubmitQuoteArgs> = {},
    actor = "maker_a",
  ): Quote {
    const payout = overrides.payout ?? 350_000_000n;
    const result = this.engine.submitQuote(actor, this.command(), {
      requestId: request.id,
      requestHash: request.termsHash,
      payout,
      priceE6: quotePrice(request.stake, payout),
      expiresAt: 5_000,
      ...overrides,
    });
    if (!("payout" in result))
      throw new Error(`Fixture quote returned ${result.state}`);
    return result;
  }

  select(request: RequestRecord): RequestRecord {
    this.clock.set(2_000);
    return this.engine.select("keeper", this.command(), {
      requestId: request.id,
    });
  }

  accept(
    request: RequestRecord,
    quote: Quote,
    command = this.command(),
    actor = "taker",
  ) {
    return this.engine.accept(actor, command, {
      requestId: request.id,
      quoteId: quote.id,
    });
  }

  offer() {
    const request = this.request();
    const quote = this.quote(request);
    this.select(request);
    return { request, quote };
  }
}
