/** Run the isolated examples and optionally retain their databases and traces. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { printTraces } from "./output";
import { runScenario, SCENARIOS, type ScenarioName } from "./scenarios";

function main(argv: string[]): void {
  let selected: ScenarioName | "all" = "all";
  let output: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run examples/demo.ts [--scenario all|" +
          SCENARIOS.join("|") +
          "] [--output NEW_DIRECTORY] [--json]",
      );
      console.log(
        "JSON trace amounts are exact decimal strings in micro-units.",
      );
      console.log(
        "Offline HIP-4 metadata fixture: mainnet identities, simulated wallets/quotes/results, no live orders.",
      );
      return;
    } else if (arg === "--scenario") {
      const value = argv[++index];
      if (value !== "all" && !SCENARIOS.includes(value as ScenarioName))
        throw new Error("Unknown or missing scenario");
      selected = value as ScenarioName | "all";
    } else if (arg === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error("--output requires a new directory path");
      output = resolve(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  let directory: string;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(output); // Refuse to overwrite an existing demo or user directory.
    directory = output;
  } else directory = mkdtempSync(join(tmpdir(), "rfq-demo-"));
  try {
    const names = selected === "all" ? SCENARIOS : [selected];
    const traces = names.map((name) =>
      runScenario(name, join(directory, `${name}.sqlite3`)),
    );
    // This human-facing JSON view uses decimal strings; receipts use the separate
    // tagged, lossless codec. No monetary value passes through Number here.
    const traceText =
      JSON.stringify(
        traces,
        (_key: string, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        2,
      ) + "\n";
    if (output)
      writeFileSync(join(directory, "trace.json"), traceText, { flag: "wx" });
    if (json) process.stdout.write(traceText);
    else {
      printTraces(traces);
    }
  } finally {
    if (!output) rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) main(process.argv.slice(2));
