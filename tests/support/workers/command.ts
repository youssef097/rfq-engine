import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Engine } from "../../../src/engine";
import { decode, DomainError, encode } from "../../../src/domain/index";

export type RaceJob = {
  actor: string;
  commandId: string;
} & (
  | { operation: "accept"; args: { requestId: string; quoteId: string } }
  | { operation: "cancelRequest"; args: { requestId: string } }
  | {
      operation: "submitQuote";
      args: {
        requestId: string;
        requestHash: string;
        payout: bigint;
        priceE6: bigint;
        expiresAt: number;
      };
    }
);

export interface WorkerInput {
  path: string;
  now: number;
  readyPath: string;
  goPath: string;
  job: RaceJob;
}

export type WorkerResult =
  | { status: "ok"; result: unknown }
  | { status: "rejected"; code: string; message: string };

if (import.meta.main) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Expected worker input path");
  const input = decode<WorkerInput>(readFileSync(inputPath, "utf8"));
  const engine = new Engine({ path: input.path, clock: () => input.now });
  try {
    writeFileSync(input.readyPath, "ready");
    const deadline = Date.now() + 15_000;
    while (!existsSync(input.goPath)) {
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for race barrier");
      await Bun.sleep(5);
    }
    let output: WorkerResult;
    try {
      const job = input.job;
      let result: unknown;
      switch (job.operation) {
        case "accept":
          result = engine.accept(job.actor, job.commandId, job.args);
          break;
        case "cancelRequest":
          result = engine.cancelRequest(job.actor, job.commandId, job.args);
          break;
        case "submitQuote":
          result = engine.submitQuote(job.actor, job.commandId, job.args);
          break;
      }
      output = { status: "ok", result };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      output = { status: "rejected", code: error.code, message: error.message };
    }
    process.stdout.write(encode(output));
  } finally {
    engine.close();
  }
}
