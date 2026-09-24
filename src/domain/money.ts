import { money } from "./validation";
import { UNIT } from "./policy";

export function quotePrice(stake: bigint, payout: bigint): bigint {
  money(stake, "stake", 1n);
  money(payout, "payout", 1n);
  return (stake * UNIT + payout / 2n) / payout;
}
