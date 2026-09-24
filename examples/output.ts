/** Human-readable rendering of the same asserted traces exposed as JSON. */
import assert from "node:assert/strict";
import { formatDecimalUnits } from "../src/integrations/hip4/index";
import { LEDGER_DECIMALS } from "./metadata";
import type { ScenarioTrace } from "./scenarios";

export function printTraces(traces: readonly ScenarioTrace[]): void {
  const metadata = traces[0]?.metadata;
  assert(metadata, "At least one scenario must be selected");
  console.log(metadata.executionMode);
  console.log(`Metadata source: ${metadata.source.endpoint}`);
  console.log(
    `Captured UTC: ${metadata.source.capturedAt}; network: ${metadata.network}`,
  );
  console.log(`Outcome metadata SHA-256: ${metadata.source.outcomeMetaSha256}`);
  console.log(
    `${metadata.quoteAsset.symbol}: native ${metadata.quoteAsset.nativeDecimals} decimals; ` +
      `local ledger ${metadata.quoteAsset.ledgerDecimals} decimals; ` +
      `${metadata.quoteAsset.nativeUnitsPerLedgerUnit} native atomic units per ledger micro-unit`,
  );
  console.log(metadata.quoteAsset.sizePrecisionNote);
  console.log("Pinned outcome identities and raw side labels:");
  for (const market of metadata.marketCatalog) {
    console.log(`  ${market.marketId}: ${market.name}`);
    console.log(`    ${market.description}`);
    console.log(
      "    " +
        market.sides
          .map(
            (side) =>
              `${side.localSide}=side ${side.side} ${side.coin} (${side.label}); token ${side.token}; asset ${side.assetId}`,
          )
          .join(" | "),
    );
  }
  console.log("UTC schedule:");
  for (const [name, value] of Object.entries(metadata.timesUtc)) {
    console.log(`  ${name}: ${value}`);
  }
  console.log(`Dispute period: ${metadata.disputePeriodMs} ms (1 hour)`);
  console.log(
    `Minimum adjudication period: ${metadata.adjudicationPeriodMs} ms (1 hour)`,
  );
  console.log("Simulated identities (no wallets or keys are used):");
  for (const [role, identity] of Object.entries(metadata.simulatedActors)) {
    console.log(`  ${role}: ${identity}`);
  }
  console.log(metadata.pricingNote);
  console.log(
    `Stake ${formatDecimalUnits(metadata.stakeMicroUnits, LEDGER_DECIMALS)} USDC; ` +
      `total payouts ${metadata.illustrativeOffers.map((offer) => formatDecimalUnits(offer.payout, LEDGER_DECIMALS)).join(" / ")} USDC`,
  );
  console.log(`${metadata.resolutionNote}\n`);
  for (const trace of traces) {
    console.log(`PASS ${trace.scenario}`);
    console.log(
      "  ticket: " +
        trace.metadata.marketCatalog
          .filter((market) => market.selected)
          .map((market) => `${market.outcomeId}:YES`)
          .join(" + "),
    );
    for (const step of trace.steps) console.log(`  ${step.atUtc} ${step.step}`);
    console.log(
      `  conserved: ${trace.finalAudit.totalFunded} micro-units; provenance verified`,
    );
  }
  console.log(
    `\n${traces.length} asserted scenarios passed. No external services or real funds used.`,
  );
}
