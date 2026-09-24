import type { Store } from "../storage/index";
import type { Outcome, Position } from "../domain/types";
import type { Hip4Network } from "../domain/hip4-binding";

export type ResolutionResult = Outcome;
export interface ProposeResultArgs {
  marketId: string;
  result: ResolutionResult;
  evidence: string;
}
/** Trusted mock observation; this is not a signed native settlement action. */
export interface ProposeHip4ResultArgs {
  network: Hip4Network;
  outcome: number;
  settleFraction: string;
  nameAndDescription: [string, string];
  sideNames: [string, string];
  evidence: string;
}
export interface DisputeResultArgs {
  marketId: string;
  reason: string;
}
export interface FinalizeResultArgs {
  marketId: string;
}
export interface ArbitrateResultArgs extends ProposeResultArgs {}
export interface SettleArgs {
  positionId: string;
}

/** Synchronous capabilities supplied by the one execution authority. */
export interface ResolutionHost {
  readonly store: Store;
  command<T>(
    actor: string,
    commandId: string,
    payload: unknown,
    action: (now: number) => T,
  ): T;
  event(
    now: number,
    kind: string,
    id: string,
    type: string,
    payload: unknown,
  ): void;
  fault(stage: string): void;
  readPosition(id: string): Position;
}
