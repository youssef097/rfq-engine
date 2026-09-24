/** Public facade; every operation uses the host's single command authority. */
import type { Market, Position } from "../domain/types";
import { proposeResult, proposeHip4Result } from "./proposals";
import {
  disputeResult,
  finalizeMarket,
  finalizeResult,
  arbitrateResult,
} from "./adjudication";
import { settlePosition, settle } from "./settlement";
import type {
  ArbitrateResultArgs,
  DisputeResultArgs,
  FinalizeResultArgs,
  ProposeHip4ResultArgs,
  ProposeResultArgs,
  ResolutionHost,
  SettleArgs,
} from "./types";

export class ResolutionService {
  constructor(private readonly host: ResolutionHost) {}

  proposeResult(
    actor: string,
    commandId: string,
    args: ProposeResultArgs,
  ): Market {
    return proposeResult(this.host, actor, commandId, args);
  }

  proposeHip4Result(
    actor: string,
    commandId: string,
    args: ProposeHip4ResultArgs,
  ): Market {
    return proposeHip4Result(this.host, actor, commandId, args);
  }

  disputeResult(
    actor: string,
    commandId: string,
    args: DisputeResultArgs,
  ): Market {
    return disputeResult(this.host, actor, commandId, args);
  }

  arbitrateResult(
    actor: string,
    commandId: string,
    args: ArbitrateResultArgs,
  ): Market {
    return arbitrateResult(this.host, actor, commandId, args);
  }

  finalizeResult(
    actor: string,
    commandId: string,
    args: FinalizeResultArgs,
  ): Market {
    return finalizeResult(this.host, actor, commandId, args);
  }

  /** Recovery already owns the surrounding command transaction. */
  finalizeMarket(marketId: string, now: number): boolean {
    return finalizeMarket(this.host, marketId, now);
  }

  settle(actor: string, commandId: string, args: SettleArgs): Position {
    return settle(this.host, actor, commandId, args);
  }

  /** Recovery already owns the surrounding command transaction. */
  settlePosition(positionId: string, now: number): Position {
    return settlePosition(this.host, positionId, now);
  }
}
