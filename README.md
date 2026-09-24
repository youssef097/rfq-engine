# RFQ matching and settlement engine

A TypeScript and Bun implementation of matching, acceptance, escrow, and resolution for whole-ticket binary-outcome parlays. State and money movements commit together in SQLite. Identity, funding, maker quotes, and resolution observations are mocked.

## Interpretation of multi-leg requests

Based on our initial discussion, I interpreted multi-leg requests as parlays: one ticket, one stake, and a single payoff determined by the combined outcomes. Makers compete to quote the complete ticket, and the selected maker backs its full liability with collateral. Pricing the combination, including any correlation between outcomes, remains the maker’s responsibility. The engine compares whole-ticket quotes without combining individual leg prices or assuming independent outcomes.

Each accepted ticket therefore has one maker and one escrow balance. At acceptance, the engine rechecks every market and commits both parties’ funding, all position legs, and the release of competing quote reservations in a single transaction. If any leg is no longer eligible, the entire ticket is rejected and its reservations are released. If creation fails partway through, every change made by that attempt is rolled back. A partially funded position never becomes visible.

This is how I apply the brief’s all-or-nothing requirement: the complete parlay is accepted and funded together, or none of it is. The references to per-leg quotes could also imply matching legs separately, potentially with different makers. That is a different matching model and is outside this implementation.

## Run

Requires Bun 1.2.8 or newer.

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs strict TypeScript checking, the automated tests, and the asserted end-to-end demo scenarios. The tests and demos run locally without API keys, external services, or real funds.

To run the happy path and two failure paths individually:

```sh
bun run demo --scenario win
bun run demo --scenario invalid_leg
bun run demo --scenario rollback
```

`invalid_leg` rejects the ticket when its second market becomes ineligible. `rollback` injects a failure after the first leg is written and verifies that funding and position creation roll back together.

## Deliverables

- [State machine](docs/state-machine.pdf)
- [Failure-mode notes](docs/failure-modes.pdf)
- [Resolution design](docs/resolution.pdf)
- [Quote-lifetime design note](docs/quote-lifetimes.pdf)
- [Working implementation](src/engine.ts), [tests](tests/), and [end-to-end demos](examples/demo.ts)
