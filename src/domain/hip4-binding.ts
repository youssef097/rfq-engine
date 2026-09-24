export type Hip4Network = "mainnet" | "testnet";

export interface Hip4Binding {
  network: Hip4Network;
  outcome: number;
  name: string;
  description: string;
  sideSpecs: [{ name: string }, { name: string }];
  quoteToken: string;
  venue: string | null;
  deployerFeeScale: string | null;
  question: {
    question: number;
    name: string;
    description: string;
    fallbackOutcome: number;
    namedOutcomes: number[];
    settledNamedOutcomes: number[];
  } | null;
  source: {
    endpoint: string;
    capturedAt: number;
    sha256: string;
  };
}
