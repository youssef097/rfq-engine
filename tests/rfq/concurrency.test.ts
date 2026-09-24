import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, encode, quotePrice } from "../../src/domain/index";
import { TestRig } from "../support/fixtures";
import type {
  RaceJob,
  WorkerInput,
  WorkerResult,
} from "../support/workers/command";

const worker = fileURLToPath(
  new URL("../support/workers/command.ts", import.meta.url),
);

async function race(
  rig: TestRig,
  jobs: RaceJob[],
  now = 2_000,
): Promise<WorkerResult[]> {
  const goPath = join(rig.directory, "go");
  const inputs = jobs.map(
    (job, index): WorkerInput => ({
      path: rig.path,
      now,
      readyPath: join(rig.directory, `ready_${index}`),
      goPath,
      job,
    }),
  );
  const children = inputs.map((input, index) => {
    const inputPath = join(rig.directory, `input_${index}`);
    writeFileSync(inputPath, encode(input));
    return Bun.spawn([process.execPath, worker, inputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!inputs.every((input) => existsSync(input.readyPath))) {
      const failed = children.find((child) => child.exitCode !== null);
      if (failed)
        throw new Error(
          `Worker exited before ready: ${await new Response(failed.stderr).text()}`,
        );
      if (Date.now() >= deadline)
        throw new Error("Workers did not reach the race barrier");
      await Bun.sleep(5);
    }
    writeFileSync(goPath, "go");
    return await Promise.all(
      children.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        return decode<WorkerResult>(stdout);
      }),
    );
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}

describe("independent Bun process races", () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = new TestRig({
      balances: {
        taker: 100_000_000n,
        maker_a: 1_000_000_000n,
        maker_b: 1_000_000_000n,
        limited_maker: 300_000_000n,
      },
    });
  });
  afterEach(() => {
    try {
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("different command IDs cannot fund one request twice", async () => {
    const { request, quote } = rig.offer();
    const args = { requestId: request.id, quoteId: quote.id };
    const results = await race(rig, [
      { operation: "accept", actor: "taker", commandId: "accept_one", args },
      { operation: "accept", actor: "taker", commandId: "accept_two", args },
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "ok",
      "rejected",
    ]);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      code: "REQUEST_CONSUMED",
    });
    expect(rig.engine.snapshot().positions).toHaveLength(1);
    expect(rig.engine.balance("taker")).toBe(0n);
    expect(rig.engine.balance("maker_a")).toBe(750_000_000n);
  }, 25_000);

  test("same command races return identical lossless receipts", async () => {
    const { request, quote } = rig.offer();
    const job: RaceJob = {
      operation: "accept",
      actor: "taker",
      commandId: "same_accept",
      args: { requestId: request.id, quoteId: quote.id },
    };
    const results = await race(rig, [job, job]);
    expect(results[0]!).toEqual(results[1]!);
    expect(results[0]!.status).toBe("ok");
    expect(results[0]).toMatchObject({
      result: {
        requestId: request.id,
        quoteId: quote.id,
        state: "OPEN",
        stake: 100_000_000n,
        makerCollateral: 250_000_000n,
        payout: 350_000_000n,
      },
    });
    expect(
      rig.engine
        .snapshot()
        .commands!.filter(
          (receipt) =>
            receipt.actor === "taker" && receipt.commandId === "same_accept",
        ),
    ).toHaveLength(1);
    expect(rig.engine.snapshot().positions).toHaveLength(1);
    expect(rig.engine.balance("taker")).toBe(0n);
  }, 25_000);

  test("two RFQs competing for one requester balance cannot overdraw", async () => {
    const first = rig.request({ stake: 80_000_000n });
    const second = rig.request({ stake: 80_000_000n });
    const a = rig.quote(first, { payout: 200_000_000n });
    const b = rig.quote(second, { payout: 200_000_000n }, "maker_b");
    rig.select(first);
    rig.select(second);
    const results = await race(rig, [
      {
        operation: "accept",
        actor: "taker",
        commandId: "first_accept",
        args: { requestId: first.id, quoteId: a.id },
      },
      {
        operation: "accept",
        actor: "taker",
        commandId: "second_accept",
        args: { requestId: second.id, quoteId: b.id },
      },
    ]);
    // Insufficient taker funds is a committed business closure, so both
    // commands succeed even though only one returns a funded position.
    expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: expect.objectContaining({ state: "OPEN" }),
        }),
        expect.objectContaining({
          result: expect.objectContaining({
            state: "REJECTED",
            reason: "INSUFFICIENT_TAKER_FUNDS",
          }),
        }),
      ]),
    );
    expect(rig.engine.snapshot().positions).toHaveLength(1);
    expect(rig.engine.balance("taker")).toBe(20_000_000n);
    expect(
      [
        rig.engine.request(first.id).state,
        rig.engine.request(second.id).state,
      ].sort(),
    ).toEqual(["FILLED", "REJECTED"]);
    expect(
      [rig.engine.balance("maker_a"), rig.engine.balance("maker_b")].sort(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      ),
    ).toEqual([880_000_000n, 1_000_000_000n]);
  }, 25_000);

  test("concurrent quotes cannot reserve the same maker capital twice", async () => {
    const requests = [rig.request(), rig.request()];
    const jobs: RaceJob[] = requests.map((request, index) => ({
      operation: "submitQuote",
      actor: "limited_maker",
      commandId: `reserve_${index}`,
      args: {
        requestId: request.id,
        requestHash: request.termsHash,
        payout: 350_000_000n,
        priceE6: quotePrice(request.stake, 350_000_000n),
        expiresAt: 5_000,
      },
    }));
    const results = await race(rig, jobs, 1_000);
    expect(results.map((result) => result.status).sort()).toEqual([
      "ok",
      "rejected",
    ]);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      code: "INSUFFICIENT_FUNDS",
    });
    expect(rig.engine.balance("limited_maker")).toBe(50_000_000n);
    expect(rig.engine.snapshot().quotes).toHaveLength(1);
    expect(rig.engine.snapshot().positions).toHaveLength(0);
  }, 25_000);

  test("concurrent competitive replacements preserve book bound and each refund", async () => {
    rig.close();
    rig = new TestRig({
      balances: {
        taker: 100_000_000n,
        maker_a: 1_000_000_000n,
        maker_b: 1_000_000_000n,
        ...Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [`dust_${index}`, 1n]),
        ),
      },
    });
    const request = rig.request();
    const dust = Array.from({ length: 32 }, (_, index) =>
      rig.quote(request, { payout: 100_000_001n }, `dust_${index}`),
    );
    const jobs: RaceJob[] = ["maker_a", "maker_b"].map((actor, index) => ({
      operation: "submitQuote",
      actor,
      commandId: `replace_${index}`,
      args: {
        requestId: request.id,
        requestHash: request.termsHash,
        payout: 350_000_000n,
        priceE6: quotePrice(request.stake, 350_000_000n),
        expiresAt: 5_000,
      },
    }));
    const results = await race(rig, jobs, 1_000);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
    expect(
      rig.engine.snapshot().quotes!.filter((quote) => quote.state === "LIVE"),
    ).toHaveLength(32);
    expect(rig.engine.balance("maker_a")).toBe(750_000_000n);
    expect(rig.engine.balance("maker_b")).toBe(750_000_000n);
    for (const [index, quote] of dust.entries()) {
      expect(rig.engine.quote(quote.id).state).toBe(
        index >= 30 ? "REJECTED" : "LIVE",
      );
      expect(rig.engine.balance(quote.maker)).toBe(index >= 30 ? 1n : 0n);
    }
    const before = rig.engine.snapshot();
    for (const job of jobs) {
      if (job.operation !== "submitQuote") throw new Error("Unexpected job");
      rig.engine.submitQuote(job.actor, job.commandId, job.args);
    }
    expect(rig.engine.snapshot()).toEqual(before);
  }, 25_000);

  test("accept/cancel race has one authoritative financial outcome", async () => {
    const { request, quote } = rig.offer();
    const results = await race(rig, [
      {
        operation: "accept",
        actor: "taker",
        commandId: "racing_accept",
        args: { requestId: request.id, quoteId: quote.id },
      },
      {
        operation: "cancelRequest",
        actor: "taker",
        commandId: "racing_cancel",
        args: { requestId: request.id },
      },
    ]);
    const state = rig.engine.request(request.id).state;
    expect(["FILLED", "CANCELLED"]).toContain(state);
    if (state === "FILLED") {
      expect(results[0]).toMatchObject({
        status: "ok",
        result: { state: "OPEN", requestId: request.id, quoteId: quote.id },
      });
      expect(results[1]).toMatchObject({
        status: "rejected",
        code: "REQUEST_CONSUMED",
      });
    } else {
      for (const result of results)
        expect(result).toMatchObject({
          status: "ok",
          result: {
            id: request.id,
            state: "CANCELLED",
            reason: "REQUESTER_CANCELLED",
          },
        });
    }
    expect(rig.engine.snapshot().positions).toHaveLength(
      state === "FILLED" ? 1 : 0,
    );
    expect(rig.engine.balance("taker")).toBe(
      state === "FILLED" ? 0n : 100_000_000n,
    );
    expect(rig.engine.balance("maker_a")).toBe(
      state === "FILLED" ? 750_000_000n : 1_000_000_000n,
    );
    expect(
      rig.engine
        .snapshot()
        .quotes!.some((row) =>
          ["LIVE", "SELECTED"].includes(String(row.state)),
        ),
    ).toBe(false);
  }, 25_000);
});
