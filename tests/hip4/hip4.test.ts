import { describe, expect, test } from "bun:test";
import {
  binaryResultFromFraction,
  convertUnitsExact,
  formatDecimalUnits,
  HIP4_INFO_ENDPOINTS,
  hip4MarketId,
  hip4Side,
  parseDecimalUnits,
  sideForCoin,
  validateHip4Binding,
  type Hip4Binding,
} from "../../src/integrations/hip4/index";
import { DomainError } from "../../src/domain/index";

function binding(): Hip4Binding {
  return {
    network: "testnet",
    outcome: 2982,
    name: "template:sportsContestWinner",
    description:
      "participantA:Los Angeles Dodgers|participantB:Cincinnati Reds|countedPlay:full game, including extra innings",
    sideSpecs: [
      { name: "template:{shortNameA}" },
      { name: "template:{shortNameB}" },
    ],
    quoteToken: "USDC",
    venue: "txyz",
    deployerFeeScale: "1.0",
    question: null,
    source: {
      endpoint: HIP4_INFO_ENDPOINTS.testnet,
      capturedAt: 1_790_000_000_000,
      sha256: "ab".repeat(32),
    },
  };
}

function memberBinding(): Hip4Binding {
  return {
    ...binding(),
    outcome: 2761,
    name: "template:sportsContestParticipant2",
    description: "participant:Real Madrid",
    sideSpecs: [{ name: "Yes" }, { name: "No" }],
    question: {
      question: 258,
      name: "template:sportsContestResult",
      description:
        "participantA:Elche CF|participantB:Real Madrid|countedPlay:regulation time, 90 minutes plus stoppage time",
      fallbackOutcome: 2758,
      namedOutcomes: [2759, 2760, 2761],
      settledNamedOutcomes: [],
    },
  };
}

function rejectsCode(action: () => unknown, code: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(DomainError);
  expect((failure as DomainError).code).toBe(code);
}

describe("immutable HIP-4 metadata binding", () => {
  test("preserves raw descriptions labels fee precision and network identity", () => {
    const raw = binding();
    raw.name = "  raw template name  ";
    raw.sideSpecs = [{ name: "Dodgers" }, { name: "Reds" }];
    raw.deployerFeeScale = "0.123456789012345678901234567890";
    const copy = validateHip4Binding(raw);
    expect(copy).toEqual(raw);
    expect(hip4MarketId(copy)).toBe("hip4:testnet:2982");
    expect(hip4MarketId({ ...copy, network: "mainnet" })).toBe(
      "hip4:mainnet:2982",
    );
    expect(sideForCoin(copy, "#29820")).toBe(0);
    expect(sideForCoin(copy, "#29821")).toBe(1);
  });

  test("deep copy prevents caller mutations from changing validated metadata", () => {
    const raw = memberBinding();
    const copy = validateHip4Binding(raw);
    raw.source.sha256 = "ff".repeat(32);
    raw.sideSpecs[0].name = "changed";
    raw.question!.namedOutcomes.push(9000);
    raw.question!.description = "changed";
    expect(copy.source.sha256).toBe("ab".repeat(32));
    expect(copy.sideSpecs[0].name).toBe("Yes");
    expect(copy.question!.namedOutcomes).toEqual([2759, 2760, 2761]);
    expect(copy.question!.description).not.toBe("changed");
  });

  test("empty member description and optional null fields are preserved", () => {
    const raw = memberBinding();
    raw.description = "";
    raw.venue = null;
    raw.deployerFeeScale = null;
    expect(validateHip4Binding(raw)).toEqual(raw);
  });

  test("named, settled and fallback membership are distinguished without reindexing", () => {
    const raw = memberBinding();
    raw.question!.settledNamedOutcomes = [2759];
    expect(validateHip4Binding(raw).question!.namedOutcomes).toEqual([
      2759, 2760, 2761,
    ]);
    raw.outcome = 2759;
    expect(validateHip4Binding(raw).outcome).toBe(2759);
    raw.question!.namedOutcomes = [2760, 2761];
    expect(validateHip4Binding(raw).outcome).toBe(2759);
    raw.outcome = 2758;
    expect(validateHip4Binding(raw).outcome).toBe(2758);
    raw.outcome = 9999;
    expect(() => validateHip4Binding(raw)).toThrow(DomainError);
  });

  test("duplicate membership and fallback masquerading as named are rejected", () => {
    for (const field of ["namedOutcomes", "settledNamedOutcomes"] as const) {
      const raw = memberBinding();
      raw.question![field] = [2761, 2761];
      expect(() => validateHip4Binding(raw)).toThrow(DomainError);
      raw.question![field] = [2758];
      expect(() => validateHip4Binding(raw)).toThrow(DomainError);
    }
  });

  test("missing, unexpected and accessor fields fail without executing getters", () => {
    const missing: Partial<Hip4Binding> = binding();
    delete missing.quoteToken;
    expect(() => validateHip4Binding(missing)).toThrow(DomainError);
    expect(() =>
      validateHip4Binding({ ...binding(), guessedSettlement: "YES" }),
    ).toThrow(DomainError);
    const extraSource = binding();
    Object.assign(extraSource.source, { final: true });
    expect(() => validateHip4Binding(extraSource)).toThrow(DomainError);
    let invoked = false;
    const accessor = binding();
    Object.defineProperty(accessor, "description", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "injected";
      },
    });
    expect(() => validateHip4Binding(accessor)).toThrow(DomainError);
    expect(invoked).toBe(false);
  });

  test("network source digest labels and quote asset are not guessed", () => {
    const cases: unknown[] = [
      { ...binding(), network: "devnet" },
      { ...binding(), name: " " },
      { ...binding(), sideSpecs: [{ name: "Yes" }] },
      { ...binding(), sideSpecs: [{ name: "" }, { name: "No" }] },
      { ...binding(), sideSpecs: ["Yes", "No"] },
      {
        ...binding(),
        source: { ...binding().source, endpoint: HIP4_INFO_ENDPOINTS.mainnet },
      },
      {
        ...binding(),
        source: {
          ...binding().source,
          endpoint: `${HIP4_INFO_ENDPOINTS.testnet}?spoof=true`,
        },
      },
      {
        ...binding(),
        source: { ...binding().source, sha256: "AB".repeat(32) },
      },
      { ...binding(), source: { ...binding().source, sha256: "a".repeat(63) } },
      { ...binding(), source: { ...binding().source, capturedAt: 1.5 } },
      { ...binding(), source: { ...binding().source, capturedAt: 1n } },
    ];
    for (const value of cases)
      expect(() => validateHip4Binding(value)).toThrow(DomainError);
    rejectsCode(
      () => validateHip4Binding({ ...binding(), quoteToken: "USDH" }),
      "UNSUPPORTED_QUOTE_TOKEN",
    );
  });

  test("fee scale accepts full bounded decimal precision and enforces [0,10]", () => {
    for (const fee of [
      "0",
      "10",
      "10.00000000000000000000000000",
      `0.${"0".repeat(125)}1`,
    ]) {
      expect(
        validateHip4Binding({ ...binding(), deployerFeeScale: fee })
          .deployerFeeScale,
      ).toBe(fee);
    }
    for (const fee of [
      "-1",
      "10.00000000000000000000000001",
      "11",
      "1e0",
      " 1",
      "+1",
      "01",
      `0.${"0".repeat(127)}`,
      1,
    ]) {
      expect(() =>
        validateHip4Binding({ ...binding(), deployerFeeScale: fee }),
      ).toThrow(DomainError);
    }
  });
});

describe("HIP-4 side identities", () => {
  test("coin token and asset namespaces preserve ordered outcome sides", () => {
    expect(hip4Side(1210, 0)).toEqual({
      outcome: 1210,
      side: 0,
      encoding: 12100,
      coin: "#12100",
      token: "+12100",
      assetId: 100012100,
    });
    expect(hip4Side(1210, 1)).toEqual({
      outcome: 1210,
      side: 1,
      encoding: 12101,
      coin: "#12101",
      token: "+12101",
      assetId: 100012101,
    });
    expect(hip4Side(0, 0).coin).toBe("#0");
  });

  test("invalid and overflowing identities cannot be rounded into another asset", () => {
    for (const outcome of [
      -1,
      1.5,
      true,
      "1210",
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() => hip4Side(outcome as never, 0)).toThrow(DomainError);
    }
    for (const side of [-1, 2, true, "0", 0n])
      expect(() => hip4Side(1210, side as never)).toThrow(DomainError);
    const maximum = Number(
      (BigInt(Number.MAX_SAFE_INTEGER) - 100_000_000n - 1n) / 10n,
    );
    expect(Number.isSafeInteger(hip4Side(maximum, 1).assetId)).toBe(true);
    expect(() => hip4Side(maximum + 1, 0)).toThrow(DomainError);
  });

  test("canonical coin must match this binding and cannot substitute token namespace", () => {
    for (const coin of [
      "#029820",
      "+29820",
      "#29822",
      "#12100",
      " #29820",
      "#29820\n",
      29820,
      null,
    ]) {
      expect(() => sideForCoin(binding(), coin)).toThrow(DomainError);
    }
  });
});

describe("exact decimal units and binary settlement boundary", () => {
  test("decimal amounts roundtrip without floats and permit exact trailing zeroes", () => {
    expect(parseDecimalUnits("100.123456", 6)).toBe(100_123_456n);
    expect(parseDecimalUnits("1.2300000000000000000000000000", 2)).toBe(123n);
    expect(parseDecimalUnits("9007199254740993.000000000000000001", 18)).toBe(
      9007199254740993000000000000000001n,
    );
    expect(parseDecimalUnits("1.0000", 0)).toBe(1n);
    for (const decimals of [0, 2, 6, 18]) {
      for (const amount of [0n, 1n, 100n, 900719925474099312345678n]) {
        expect(
          parseDecimalUnits(formatDecimalUnits(amount, decimals), decimals),
        ).toBe(amount);
      }
    }
    expect(formatDecimalUnits(1230000n, 6)).toBe("1.23");
  });

  test("decimal parser rejects ambiguity unsafe types and any nonzero dust", () => {
    for (const input of [
      1,
      0.1,
      1n,
      true,
      null,
      "-1",
      "+1",
      "01",
      "1e3",
      "1.",
      ".5",
      " 1",
      "1\n",
      "9".repeat(129),
    ]) {
      expect(() => parseDecimalUnits(input, 6)).toThrow(DomainError);
    }
    rejectsCode(() => parseDecimalUnits("0.0000001", 6), "PRECISION_LOSS");
    rejectsCode(
      () => parseDecimalUnits("1.0000000000000000001", 18),
      "PRECISION_LOSS",
    );
    for (const decimals of [-1, 19, 1.5, true, "6", 6n]) {
      expect(() => parseDecimalUnits("1", decimals as never)).toThrow(
        DomainError,
      );
      expect(() => formatDecimalUnits(1n, decimals as never)).toThrow(
        DomainError,
      );
    }
  });

  test("unit conversions reject loss rather than truncating dust", () => {
    expect(convertUnitsExact(100_000_001n, 6, 8)).toBe(10_000_000_100n);
    expect(convertUnitsExact(10_000_000_100n, 8, 6)).toBe(100_000_001n);
    expect(convertUnitsExact(0n, 18, 0)).toBe(0n);
    rejectsCode(
      () => convertUnitsExact(10_000_000_101n, 8, 6),
      "PRECISION_LOSS",
    );
    for (const amount of [-1n, 1, "1", true]) {
      expect(() => convertUnitsExact(amount as never, 6, 8)).toThrow(
        DomainError,
      );
      expect(() => formatDecimalUnits(amount as never, 6)).toThrow(DomainError);
    }
  });

  test("native endpoint fractions become binary results with no precision cap", () => {
    for (const value of ["0", "0.0", `0.${"0".repeat(126)}`])
      expect(binaryResultFromFraction(value)).toBe("NO");
    for (const value of ["1", "1.0000000000000000000000000000000000000000"])
      expect(binaryResultFromFraction(value)).toBe("YES");
  });

  test("fractional redemption is explicitly unsupported, never silently VOID", () => {
    for (const value of [
      "0.5",
      "0.123456789012345678901234567890",
      `0.${"0".repeat(125)}1`,
    ]) {
      rejectsCode(
        () => binaryResultFromFraction(value),
        "FRACTIONAL_OUTCOME_UNSUPPORTED",
      );
    }
    for (const value of [
      0,
      1,
      "-0.1",
      "1.00000000000000000001",
      "2",
      "1e0",
      ".5",
    ]) {
      expect(() => binaryResultFromFraction(value)).toThrow(DomainError);
    }
  });
});
