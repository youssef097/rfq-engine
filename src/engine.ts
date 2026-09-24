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
  proposeResult,
  proposeHip4Result,
  disputeResult,
  finalizeResult,
  finalizeMarket,
  arbitrateResult,
  settle,
  settlePosition,
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

/** Trusted local authority. Actor strings are mocked, already-authenticated identities. */
export class Engine {
  private readonly context: CommandContext;
  private readonly queries: Queries;
  private readonly lifecycle: RfqLifecycle;
  constructor(options: EngineOptions = {}) {
    this.context = new CommandContext(options);
    this.queries = new Queries(this.context.store, this.context.records);
    this.lifecycle = new RfqLifecycle(this.context);
  }
  close(): void {
    this.store.close();
  }
  /** Privileged diagnostic access; never expose this through an untrusted transport. */
  get store() {
    return this.context.store;
  }
  /** Trusted hook for command-boundary tests; application callers use named commands. */
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
    bootstrapFixture(this.context, balances, markets, operator);
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
          finalizeMarket: (id, at) => finalizeMarket(this.context, id, at),
          settlePosition: (id, at) => settlePosition(this.context, id, at),
        },
        now,
        limit,
      ),
    );
  }
  proposeResult(actor: string, commandId: string, args: ProposeResultArgs) {
    return proposeResult(this.context, actor, commandId, args);
  }
  proposeHip4Result(
    actor: string,
    commandId: string,
    args: ProposeHip4ResultArgs,
  ) {
    return proposeHip4Result(this.context, actor, commandId, args);
  }
  disputeResult(actor: string, commandId: string, args: DisputeResultArgs) {
    return disputeResult(this.context, actor, commandId, args);
  }
  finalizeResult(actor: string, commandId: string, args: FinalizeResultArgs) {
    return finalizeResult(this.context, actor, commandId, args);
  }
  arbitrateResult(actor: string, commandId: string, args: ArbitrateResultArgs) {
    return arbitrateResult(this.context, actor, commandId, args);
  }
  settle(actor: string, commandId: string, args: SettleArgs) {
    return settle(this.context, actor, commandId, args);
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
