import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { DomainError, quotePrice } from "../../src/domain/index";
import type { Quote, RequestRecord } from "../../src/domain/types";
import { runRecovery } from "../../src/recovery/recover";
import { fixtureMarkets, TestRig } from "../support/fixtures";

const crashWorker = fileURLToPath(
  new URL("../support/workers/crash.ts", import.meta.url),
);

describe("durability and recovery", () => {
  test.each([
    "after_stake_debit",
    "after_maker_debit",
    "after_leg:0",
    "before_commit",
    "after_commit",
  ])(
    "actual process exit at %s recovers correctly",
    async (stage) => {
      const rig = new TestRig();
      try {
        const { request, quote } = rig.offer();
        const before = rig.engine.snapshot();
        const child = Bun.spawn(
          [
            process.execPath,
            crashWorker,
            rig.path,
            stage,
            request.id,
            quote.id,
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(77);
        rig.reopen();
        if (stage === "after_commit") {
          expect(rig.engine.snapshot().positions).toHaveLength(1);
        } else {
          expect(rig.engine.snapshot()).toEqual(before);
        }
        const committedJournal =
          stage === "after_commit" ? rig.engine.snapshot().journal : null;
        const result = rig.accept(request, quote, "durable_accept");
        expect(result.state).toBe("OPEN");
        expect(typeof result.stake).toBe("bigint");
        expect(rig.engine.snapshot().positions).toHaveLength(1);
        if (committedJournal)
          expect(rig.engine.snapshot().journal).toEqual(committedJournal);
        expect(rig.engine.audit().ok).toBe(true);
      } finally {
        rig.close();
      }
    },
    20_000,
  );

  test("restart releases expired reservations without reusing request nonce", () => {
    const rig = new TestRig();
    try {
      const request = rig.request({ nonce: "survives_restart" });
      rig.quote(request);
      rig.clock.set(5_000);
      rig.reopen();
      rig.engine.recover("keeper", rig.command());
      expect(rig.engine.request(request.id).state).toBe("EXPIRED");
      expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
      expect(() =>
        rig.request({
          nonce: "survives_restart",
          responseDeadline: 6_000,
          acceptanceDeadline: 7_000,
        }),
      ).toThrow(DomainError);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("individual quote can expire during collection without closing RFQ", () => {
    const rig = new TestRig();
    try {
      const request = rig.request();
      const quote = rig.quote(request, { expiresAt: 1_500 });
      rig.clock.set(1_500);
      rig.engine.recover("keeper", rig.command());
      expect(rig.engine.quote(quote.id).state).toBe("EXPIRED");
      expect(rig.engine.request(request.id).state).toBe("COLLECTING");
      expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
      expect(rig.quote(request).state).toBe("LIVE");
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("recovery requires its caller's transaction before invoking any handler", () => {
    const rig = new TestRig();
    try {
      const before = rig.engine.snapshot();
      const unexpected = () => {
        throw new Error("Recovery called a handler outside a transaction");
      };
      try {
        runRecovery(
          {
            store: rig.engine.store,
            refreshRequest: unexpected,
            expireQuote: unexpected,
            finalizeMarket: unexpected,
            settlePosition: unexpected,
          },
          20_000,
          100,
        );
        throw new Error("Expected transaction guard to reject recovery");
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("TRANSACTION_REQUIRED");
      }
      expect(rig.engine.snapshot()).toEqual(before);
    } finally {
      rig.close();
    }
  });

  test("recovery never selects a mature RFQ or accepts an available offer", () => {
    const rig = new TestRig();
    try {
      const request = rig.request();
      const quote = rig.quote(request);
      rig.clock.set(2_000);
      const empty = {
        requests: 0,
        quotes: 0,
        markets: 0,
        positions: 0,
        hasMore: false,
      };
      expect(rig.engine.recover("keeper", rig.command())).toEqual(empty);
      expect(rig.engine.request(request.id)).toEqual(request);
      expect(rig.engine.quote(quote.id)).toEqual(quote);

      const offered = rig.select(request);
      const selectedQuote = rig.engine.quote(quote.id);
      const funded = rig.engine.snapshot();
      rig.clock.set(4_999);
      expect(rig.engine.recover("keeper", rig.command())).toEqual(empty);
      expect(rig.engine.request(request.id)).toEqual(offered);
      expect(rig.engine.quote(quote.id)).toEqual(selectedQuote);
      expect(rig.engine.snapshot().positions).toEqual([]);
      expect(rig.engine.snapshot().balances).toEqual(funded.balances!);
      expect(rig.engine.snapshot().journal).toEqual(funded.journal!);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("replaying a bounded batch after restart returns its receipt without draining more work", () => {
    const rig = new TestRig();
    try {
      const requests = [rig.request(), rig.request()];
      for (const request of requests) rig.quote(request);
      rig.clock.set(5_000);
      const command = rig.command();
      const first = rig.engine.recover("keeper", command, { limit: 1 });
      expect(first).toEqual({
        requests: 1,
        quotes: 0,
        markets: 0,
        positions: 0,
        hasMore: true,
      });
      const afterFirst = rig.engine.snapshot();
      rig.reopen();
      // Receipt lookup must precede both the clock read and candidate selection.
      rig.clock.set(4_999);
      expect(rig.engine.recover("keeper", command, { limit: 1 })).toEqual(
        first,
      );
      expect(rig.engine.snapshot()).toEqual(afterFirst);

      rig.clock.set(5_000);
      expect(rig.engine.recover("keeper", rig.command(), { limit: 2 })).toEqual(
        { ...first, quotes: 1, hasMore: false },
      );
      for (const request of requests)
        expect(rig.engine.request(request.id).state).toBe("EXPIRED");
      expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("a failed settlement rolls back earlier queue work and the whole batch can retry after restart", () => {
    const rig = new TestRig({ markets: [fixtureMarkets()[0]!] });
    try {
      const legs = [{ marketId: "market_0", side: "YES" as const }];
      const abandoned = rig.request({ legs });
      const abandonedQuote = rig.quote(abandoned);
      const request = rig.request({ legs });
      const quote = rig.quote(request);
      rig.select(request);
      const position = rig.engine.position(rig.accept(request, quote).id);
      rig.clock.set(11_000);
      rig.engine.proposeResult("oracle", rig.command(), {
        marketId: "market_0",
        result: "YES",
        evidence: "Mature proposal is finalized in the recovery transaction",
      });
      rig.clock.set(12_000);
      const before = rig.engine.snapshot();
      const command = rig.command();
      rig.faultStage = "after_settlement_transfer";
      expect(() => rig.engine.recover("keeper", command, { limit: 3 })).toThrow(
        "after_settlement_transfer",
      );
      expect(rig.engine.snapshot()).toEqual(before);
      expect(rig.engine.request(abandoned.id).state).toBe("COLLECTING");
      expect(rig.engine.market("market_0").state).toBe("PROPOSED");
      expect(rig.engine.position(position.id).state).toBe("OPEN");
      expect(rig.engine.audit().ok).toBe(true);

      rig.faultStage = null;
      rig.reopen();
      const recovered = rig.engine.recover("keeper", command, { limit: 3 });
      expect(recovered).toEqual({
        requests: 1,
        quotes: 0,
        markets: 1,
        positions: 1,
        hasMore: false,
      });
      expect(rig.engine.request(abandoned.id).state).toBe("EXPIRED");
      expect(rig.engine.quote(abandonedQuote.id).state).toBe("EXPIRED");
      expect(rig.engine.market("market_0").finalResult).toBe("YES");
      expect(rig.engine.position(position.id).state).toBe("WON");
      expect(rig.engine.request(request.id).state).toBe("SETTLED");
      expect(rig.engine.balance("taker")).toBe(1_250_000_000n);
      expect(rig.engine.balance("maker_a")).toBe(1_750_000_000n);
      const committed = rig.engine.snapshot();
      expect(rig.engine.recover("keeper", command, { limit: 3 })).toEqual(
        recovered,
      );
      expect(rig.engine.snapshot()).toEqual(committed);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("bounded recovery progresses through backlog", () => {
    const rig = new TestRig();
    try {
      const requests = [rig.request(), rig.request(), rig.request()];
      for (const request of requests) rig.quote(request);
      rig.clock.set(5_000);
      for (let i = 0; i < 12; i += 1) {
        const result = rig.engine.recover("keeper", rig.command(), {
          limit: 1,
        });
        expect(
          result.requests + result.quotes + result.markets + result.positions,
        ).toBeLessThanOrEqual(1);
        if (!result.hasMore) break;
      }
      for (const request of requests)
        expect(rig.engine.request(request.id).state).toBe("EXPIRED");
      expect(rig.engine.balance("maker_a")).toBe(2_000_000_000n);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("persisted clock prevents backwards mutation after restart", () => {
    const rig = new TestRig();
    try {
      rig.offer();
      rig.clock.set(1_999);
      rig.reopen();
      const before = rig.engine.snapshot();
      expect(() => rig.engine.recover("keeper", rig.command())).toThrow(
        DomainError,
      );
      expect(rig.engine.snapshot()).toEqual(before);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test.each([1, 100_000])(
    "same collateral rules with lifetime scale %i across restart",
    (scale) => {
      const rig = new TestRig({
        markets: fixtureMarkets(scale),
        now: 1_000 * scale,
      });
      try {
        const request = rig.request({
          responseDeadline: 2_000 * scale,
          acceptanceDeadline: 5_000 * scale,
        });
        const quote = rig.quote(request, { expiresAt: 5_000 * scale });
        rig.reopen();
        rig.clock.set(2_000 * scale);
        rig.engine.select("keeper", rig.command(), { requestId: request.id });
        rig.clock.set(4_999 * scale);
        expect(rig.accept(request, quote).state).toBe("OPEN");
        expect(rig.engine.balance("taker")).toBe(900_000_000n);
        expect(rig.engine.balance("maker_a")).toBe(1_750_000_000n);
        expect(rig.engine.audit().ok).toBe(true);
      } finally {
        rig.close();
      }
    },
  );

  test("final outcomes survive restart before payout and recovery pays once", () => {
    const rig = new TestRig();
    try {
      const { request, quote } = rig.offer();
      const position = rig.engine.position(rig.accept(request, quote).id);
      rig.clock.set(11_000);
      for (const leg of position.legs) {
        rig.engine.proposeResult("oracle", rig.command(), {
          marketId: leg.marketId,
          result: leg.side,
          evidence: "fixture result",
        });
      }
      rig.clock.set(12_000);
      for (const leg of position.legs)
        rig.engine.finalizeResult("keeper", rig.command(), {
          marketId: leg.marketId,
        });
      expect(rig.engine.position(position.id).state).toBe("OPEN");
      expect(rig.engine.balance("taker")).toBe(900_000_000n);
      rig.reopen();
      for (const leg of position.legs) {
        const market = rig.engine.market(leg.marketId);
        expect(market.adjudicationPeriod).toBe(1000);
        expect(market.termsHash).toBe(leg.marketTermsHash);
      }
      let drained = false;
      for (let page = 0; page < 12; page += 1) {
        if (
          !rig.engine.recover("keeper", rig.command(), { limit: 1 }).hasMore
        ) {
          drained = true;
          break;
        }
      }
      expect(drained).toBe(true);
      expect(rig.engine.position(position.id).state).toBe("WON");
      expect(rig.engine.balance("taker")).toBe(1_250_000_000n);
      const journal = rig.engine.snapshot().journal!;
      rig.engine.recover("keeper", rig.command());
      expect(rig.engine.snapshot().journal).toEqual(journal);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });
});

describe("independent payoff model and adversarial sequences", () => {
  test("all 54 three-leg outcome/selection combinations match independent payoff model", () => {
    let cases = 0;
    for (const side of ["YES", "NO"] as const) {
      for (const a of ["W", "L", "V"] as const) {
        for (const b of ["W", "L", "V"] as const) {
          for (const c of ["W", "L", "V"] as const) {
            const rig = new TestRig();
            try {
              const symbols = [a, b, c];
              const legs = [0, 1, 2].map((index) => ({
                marketId: `market_${index}`,
                side,
              }));
              const request = rig.request({ legs });
              const quote = rig.quote(request);
              rig.select(request);
              const position = rig.engine.position(
                rig.accept(request, quote).id,
              );
              rig.clock.set(11_000);
              legs.forEach((leg, index) => {
                const symbol = symbols[index]!;
                const opposite = side === "YES" ? "NO" : "YES";
                const result =
                  symbol === "W" ? side : symbol === "L" ? opposite : "VOID";
                rig.engine.proposeResult("oracle", rig.command(), {
                  marketId: leg.marketId,
                  result,
                  evidence: "reference case",
                });
              });
              rig.clock.set(12_000);
              for (const leg of [...legs].reverse())
                rig.engine.finalizeResult("keeper", rig.command(), {
                  marketId: leg.marketId,
                });
              const result = rig.engine.settle("keeper", rig.command(), {
                positionId: position.id,
              });
              const loss = symbols.includes("L");
              const voided = symbols.includes("V");
              const expectedState = loss ? "LOST" : voided ? "VOID" : "WON";
              const takerPayout = loss
                ? 0n
                : voided
                  ? 100_000_000n
                  : 350_000_000n;
              expect(result.state).toBe(expectedState);
              expect(rig.engine.balance("taker")).toBe(
                900_000_000n + takerPayout,
              );
              expect(rig.engine.balance("maker_a")).toBe(
                1_750_000_000n + 350_000_000n - takerPayout,
              );
              expect(rig.engine.audit().ok).toBe(true);
              cases += 1;
            } finally {
              rig.close();
            }
          }
        }
      }
    }
    expect(cases).toBe(54);
  });

  test("seeded adversarial command sequences preserve every obligation", () => {
    function simulate(seed: number) {
      let randomState = seed;
      const trace: string[] = [];
      const random = (maximum: number): number => {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        const value = randomState % maximum;
        trace.push(`draw(${maximum})=${value}`);
        return value;
      };
      let identity = 0;
      // The factory lives across reopen(), just like the PRNG and clock.
      const rig = new TestRig({
        idFactory: () => `seed_${seed}_${++identity}`,
      });
      const requests: RequestRecord[] = [];
      const quotes: Quote[] = [];
      try {
        for (let index = 0; index < 100; index += 1) {
          const before = rig.engine.snapshot();
          const operation = random(8);
          const command = rig.command();
          trace.push(
            `step=${index} at=${rig.clock.now()} command=${command} op=${operation}`,
          );
          try {
            if (operation === 0 && rig.clock.now() < 9_000) {
              requests.push(
                rig.engine.createRequest("taker", command, {
                  nonce: command,
                  stake: BigInt(random(200) + 1) * 1_000_000n,
                  legs: [
                    {
                      marketId: "market_0",
                      side: random(2) === 0 ? "YES" : "NO",
                    },
                  ],
                  responseDeadline: rig.clock.now() + 100,
                  acceptanceDeadline: Math.min(rig.clock.now() + 500, 10_000),
                }),
              );
            } else if (operation === 1 && requests.length > 0) {
              const request = requests[random(requests.length)]!;
              const payout =
                request.stake + BigInt(random(300) + 1) * 1_000_000n;
              const result = rig.engine.submitQuote(
                random(2) === 0 ? "maker_a" : "maker_b",
                command,
                {
                  requestId: request.id,
                  requestHash: request.termsHash,
                  payout,
                  priceE6: quotePrice(request.stake, payout),
                  expiresAt: request.acceptanceDeadline,
                },
              );
              if ("payout" in result) quotes.push(result);
            } else if (operation === 2 && requests.length > 0) {
              rig.engine.select("keeper", command, {
                requestId: requests[random(requests.length)]!.id,
              });
            } else if (
              operation === 3 &&
              requests.length > 0 &&
              quotes.length > 0
            ) {
              rig.engine.accept("taker", command, {
                requestId: requests[random(requests.length)]!.id,
                quoteId: quotes[random(quotes.length)]!.id,
              });
            } else if (operation === 4 && requests.length > 0) {
              rig.engine.cancelRequest("taker", command, {
                requestId: requests[random(requests.length)]!.id,
              });
            } else if (operation === 5) {
              rig.engine.recover("keeper", command, { limit: random(4) + 1 });
            } else if (operation === 6) {
              rig.reopen();
            } else {
              rig.clock.advance(random(151));
            }
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            expect(rig.engine.snapshot()).toEqual(before);
          }
          expect(rig.engine.audit().ok).toBe(true);
        }
        rig.clock.set(20_000);
        let drained = false;
        for (let page = 0; page < 200; page += 1) {
          if (
            !rig.engine.recover("keeper", rig.command(), { limit: 2 }).hasMore
          ) {
            drained = true;
            break;
          }
        }
        expect(drained).toBe(true);
        expect(
          rig.engine
            .snapshot()
            .quotes!.some((row) =>
              ["LIVE", "SELECTED"].includes(String(row.state)),
            ),
        ).toBe(false);
        expect(
          rig.engine.snapshot().positions!.some((row) => row.state === "OPEN"),
        ).toBe(false);
        expect(rig.engine.audit().ok).toBe(true);
        return rig.engine.snapshot();
      } catch (error) {
        throw new Error(
          `Simulation failed: seed=${seed}\n${trace.join("\n")}`,
          { cause: error },
        );
      } finally {
        rig.close();
      }
    }
    for (let seed = 1; seed <= 8; seed += 1) {
      // Complete durable state, including IDs, receipts, ordering and journal.
      expect(simulate(seed)).toEqual(simulate(seed));
    }
  });
});
