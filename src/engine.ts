/** Public API and composition only. Financial workflows live in their feature folders. */
import { CommandContext } from "./application/context";
import { Queries } from "./application/queries";
import { bootstrapFixture } from "./application/bootstrap";
import type { EngineOptions } from "./application/options";
import { RfqLifecycle } from "./rfq/lifecycle";
import { createRequest, cancelRequest } from "./rfq/requests";
import { submitQuote, cancelQuote } from "./rfq/quotes";
import { select } from "./rfq/selection";
import { accept } from "./rfq/acceptance";
import { haltMarket } from "./markets/halt";
import { runRecovery } from "./recovery/recover";
import { integer, objectInput } from "./domain";
import type { MarketInput } from "./domain/types";
import type {
  CreateRequestArgs,
  SubmitQuoteArgs,
  RequestArgs,
  AcceptArgs,
} from "./rfq/types";
import {
  ResolutionService,
  type ProposeResultArgs,
  type ProposeHip4ResultArgs,
  type DisputeResultArgs,
  type FinalizeResultArgs,
  type ArbitrateResultArgs,
  type SettleArgs,
} from "./resolution";
export type { EngineOptions } from "./application/options";
export type {
  CreateRequestArgs,
  SubmitQuoteArgs,
  RequestArgs,
  AcceptArgs,
} from "./rfq/types";
export { requestCommitment } from "./rfq/commitment";

/** Trusted local authority. Actor strings are mocked, already-authenticated identities. */
export class Engine {
  private readonly context: CommandContext;
  private readonly queries: Queries;
  private readonly lifecycle: RfqLifecycle;
  private readonly resolution: ResolutionService;
  constructor(options: EngineOptions = {}) {
    this.context = new CommandContext(options);
    this.queries = new Queries(this.context.store, this.context.records);
    this.lifecycle = new RfqLifecycle(this.context);
    this.resolution = new ResolutionService(this.context);
  }
  close(): void {
    this.store.close();
  }
  /** Privileged composition hooks retained for callers of the original local API. */
  fault(stage: string): void {
    this.context.fault(stage);
  }
  event(
    now: number,
    kind: string,
    id: string,
    type: string,
    payload: unknown,
  ): void {
    this.context.event(now, kind, id, type, payload);
  }
  readPosition(id: string) {
    return this.context.readPosition(id);
  }
  /** Privileged diagnostic access; never expose this through an untrusted transport. */
  get store() {
    return this.context.store;
  }
  /** Retained test/composition hook; domain consumers use named commands below. */
  command<T>(
    actor: string,
    commandId: string,
    payload: unknown,
    action: (now: number) => T,
  ): T {
    return this.context.command(actor, commandId, payload, action);
  }
  bootstrap(
    balances: Record<string, bigint>,
    markets: MarketInput[],
    operator = "operator",
  ): void {
    bootstrapFixture(
      {
        store: this.store,
        clock: this.context.clock,
        event: (...args) => this.context.event(...args),
      },
      balances,
      markets,
      operator,
    );
  }
  createRequest(actor: string, commandId: string, args: CreateRequestArgs) {
    return createRequest(this.context, actor, commandId, args);
  }
  cancelRequest(actor: string, commandId: string, args: RequestArgs) {
    return cancelRequest(this.context, this.lifecycle, actor, commandId, args);
  }
  submitQuote(actor: string, commandId: string, args: SubmitQuoteArgs) {
    return submitQuote(this.context, this.lifecycle, actor, commandId, args);
  }
  cancelQuote(actor: string, commandId: string, args: { quoteId: string }) {
    return cancelQuote(this.context, this.lifecycle, actor, commandId, args);
  }
  select(actor: string, commandId: string, args: RequestArgs) {
    return select(this.context, this.lifecycle, actor, commandId, args);
  }
  accept(actor: string, commandId: string, args: AcceptArgs) {
    return accept(this.context, this.lifecycle, actor, commandId, args);
  }
  haltMarket(
    actor: string,
    commandId: string,
    args: { marketId: string; reason: string },
  ) {
    return haltMarket(this.context, actor, commandId, args);
  }
  recover(actor: string, commandId: string, args: { limit?: number } = {}) {
    objectInput(args, ["limit"], []);
    const limit = Object.hasOwn(args, "limit")
      ? integer(args.limit, "recovery limit", 1, 1000)
      : 100;
    return this.command(actor, commandId, { op: "recover", limit }, (now) =>
      runRecovery(
        {
          store: this.store,
          refreshRequest: (id, at) =>
            this.lifecycle.refreshRequest(
              this.context.records.require("requests", id),
              at,
            ),
          expireQuote: (id, at) =>
            this.lifecycle.releaseQuote(
              this.context.records.require("quotes", id),
              "EXPIRED",
              at,
            ),
          finalizeMarket: (id, at) => this.resolution.finalizeMarket(id, at),
          settlePosition: (id, at) => this.resolution.settlePosition(id, at),
        },
        now,
        limit,
      ),
    );
  }
  proposeResult(actor: string, commandId: string, args: ProposeResultArgs) {
    return this.resolution.proposeResult(actor, commandId, args);
  }
  proposeHip4Result(
    actor: string,
    commandId: string,
    args: ProposeHip4ResultArgs,
  ) {
    return this.resolution.proposeHip4Result(actor, commandId, args);
  }
  disputeResult(actor: string, commandId: string, args: DisputeResultArgs) {
    return this.resolution.disputeResult(actor, commandId, args);
  }
  finalizeResult(actor: string, commandId: string, args: FinalizeResultArgs) {
    return this.resolution.finalizeResult(actor, commandId, args);
  }
  arbitrateResult(actor: string, commandId: string, args: ArbitrateResultArgs) {
    return this.resolution.arbitrateResult(actor, commandId, args);
  }
  settle(actor: string, commandId: string, args: SettleArgs) {
    return this.resolution.settle(actor, commandId, args);
  }
  request(id: string) {
    return this.queries.request(id);
  }
  quote(id: string) {
    return this.queries.quote(id);
  }
  position(id: string) {
    return this.queries.position(id);
  }
  market(id: string) {
    return this.queries.market(id);
  }
  balance(actor: string) {
    return this.queries.balance(actor);
  }
  snapshot() {
    return this.queries.snapshot();
  }
  audit() {
    return this.queries.audit();
  }
}
