import { Engine } from "../../../src/engine";

const [path, stage, requestId, quoteId] = process.argv.slice(2);
if (!path || !stage || !requestId || !quoteId)
  throw new Error("Expected path, stage, request and quote");
const engine = new Engine({
  path,
  clock: () => 2_000,
  fault: (point) => {
    if (point === stage) process.exit(77);
  },
});
engine.accept("taker", "durable_accept", { requestId, quoteId });
engine.close();
throw new Error("Crash point did not execute");
