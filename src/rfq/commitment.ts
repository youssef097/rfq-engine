import { POLICY } from "../domain";
import type { RequestRow, Leg } from "../domain/types";

export function requestCommitment(
  request: Pick<
    RequestRow,
    "taker" | "nonce" | "stake" | "responseDeadline" | "acceptanceDeadline"
  >,
  legs: Pick<Leg, "marketId" | "side" | "marketTermsHash">[],
): unknown {
  return {
    policy: POLICY,
    asset: "MOCK_USDC_6",
    taker: request.taker,
    nonce: request.nonce,
    stake: request.stake,
    responseDeadline: request.responseDeadline,
    acceptanceDeadline: request.acceptanceDeadline,
    legs: legs.map(({ marketId, side, marketTermsHash }) => ({
      marketId,
      side,
      marketTermsHash,
    })),
  };
}
