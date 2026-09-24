import { describe, expect, test } from "bun:test";
import {
  arrayInput,
  canonical,
  decode,
  digest,
  DomainError,
  encode,
  objectInput,
} from "../../src/domain/index";
import { TestRig } from "../support/fixtures";

describe("canonical commitments and receipt codec", () => {
  test("bigint, string, number and tag-shaped input have distinct commitments", () => {
    const values = [
      1n,
      "1",
      1,
      ["bigint", "1"],
      { bigint: "1" },
      { $bigint: "1" },
    ];
    expect(new Set(values.map(canonical)).size).toBe(values.length);
    expect(new Set(values.map(digest)).size).toBe(values.length);
    expect(digest({ b: 2n, a: "1" })).toBe(digest({ a: "1", b: 2n }));
    expect(digest([1n, 2n])).not.toBe(digest([2n, 1n]));
  });

  test("nested receipt values roundtrip bigint without narrowing or string revival", () => {
    const original = {
      amount: 123456789012345678901234567890n,
      negative: -123456789012345678901234567890n,
      text: "123456789012345678901234567890",
      timestamp: 253_402_300_799_999,
      legs: [{ side: "YES", amount: 0n, optional: null, flag: true }],
      tagShaped: { $bigint: "123", type: "bigint", value: "123" },
    };
    const restored = decode<typeof original>(encode(original));
    expect(restored).toEqual(original);
    expect(typeof restored.amount).toBe("bigint");
    expect(typeof restored.text).toBe("string");
    expect(typeof restored.timestamp).toBe("number");
    expect(restored.tagShaped.$bigint).toBe("123");
  });

  test("own __proto__ and constructor keys decode without prototype mutation", () => {
    const original: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"rfqPolluted":true},"constructor":{"prototype":{"rfqPolluted":true}},"amount":"1"}',
    );
    const restored = decode<Record<string, unknown>>(encode(original));
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.hasOwn(restored, "__proto__")).toBe(true);
    expect(restored["__proto__"]).toEqual({ rfqPolluted: true });
    expect(({} as Record<string, unknown>).rfqPolluted).toBeUndefined();
    expect(restored.amount).toBe("1");
  });

  test("cyclic unsupported lossy and excessively nested inputs fail closed", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = null;
    for (let i = 0; i < 34; i += 1) deep = [deep];
    for (const value of [
      undefined,
      () => 1,
      Symbol("value"),
      new Date(),
      new Map(),
      NaN,
      Infinity,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      cyclic,
      deep,
    ]) {
      expect(() => canonical(value)).toThrow(DomainError);
    }
  });

  test("malformed receipts cannot smuggle duplicate keys or ambiguous scalars", () => {
    const malformed = [
      "not json",
      "null",
      '["unknown",1]',
      '["bigint","01"]',
      '["bigint","1.5"]',
      '["bigint","-0"]',
      '["number",1.5]',
      '["number",9007199254740993]',
      '["null",null]',
      '["string","ok","extra"]',
      '["array",["bad"]]',
      '["object",[["a",["number",1]],["a",["number",2]]]]',
    ];
    for (const receipt of malformed)
      expect(() => decode(receipt)).toThrow(DomainError);
  });
});

describe("data-only input boundaries", () => {
  test("proxy traps cannot substitute a command target or run during encoding", () => {
    const rig = new TestRig();
    try {
      const first = rig.request();
      const second = rig.request();
      const before = rig.engine.snapshot();
      let reads = 0;
      const args = new Proxy(
        { requestId: first.id },
        {
          get: () => (++reads <= 2 ? first.id : second.id),
        },
      );
      expect(() =>
        rig.engine.cancelRequest("taker", "proxy_cancel", args),
      ).toThrow(DomainError);
      expect(reads).toBe(0);
      expect(rig.engine.snapshot()).toEqual(before);
      const traps = {
        get() {
          throw new Error("get trap ran");
        },
        ownKeys() {
          throw new Error("ownKeys trap ran");
        },
        getPrototypeOf() {
          throw new Error("prototype trap ran");
        },
      };
      expect(() => canonical(new Proxy({ amount: 1n }, traps))).toThrow(
        DomainError,
      );
      expect(() => arrayInput(new Proxy([1], traps), "items")).toThrow(
        DomainError,
      );
      expect(() => objectInput(new Proxy({}, traps), [])).toThrow(DomainError);
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      expect(() => canonical(revoked.proxy)).toThrow(DomainError);
    } finally {
      rig.close();
    }
  });

  test("objects reject accessors without invoking them", () => {
    let invoked = false;
    const object = Object.defineProperty({}, "amount", {
      enumerable: true,
      get: () => {
        invoked = true;
        return 1n;
      },
    });
    expect(() => objectInput(object, ["amount"])).toThrow(DomainError);
    expect(() => canonical(object)).toThrow(DomainError);
    expect(invoked).toBe(false);
  });

  test("object shapes reject hidden symbolic inherited and unknown fields", () => {
    const hidden = Object.defineProperty({ amount: 1n }, "extra", {
      value: 2n,
    });
    const symbolic = { amount: 1n, [Symbol("extra")]: 2n };
    const inherited: unknown = Object.create({ amount: 1n });
    const nullPrototype: unknown = Object.create(null);
    for (const value of [
      hidden,
      symbolic,
      inherited,
      nullPrototype,
      { amount: 1n, extra: 2n },
      {},
    ]) {
      expect(() => objectInput(value, ["amount"])).toThrow(DomainError);
    }
    expect(() => objectInput({ amount: 1n }, ["amount"])).not.toThrow();
  });

  test("arrays must be dense plain data without extra properties or getters", () => {
    let invoked = false;
    const accessor: unknown[] = [1];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => {
        invoked = true;
        return 1;
      },
    });
    const extended = Object.assign([1], { extra: 2 });
    const symbolic = Object.assign([1], { [Symbol("extra")]: 2 });
    const hidden = [1];
    Object.defineProperty(hidden, "0", { value: 1, enumerable: false });
    class DerivedArray extends Array<number> {}
    for (const value of [
      new Array(1),
      accessor,
      extended,
      symbolic,
      hidden,
      new DerivedArray(1),
    ]) {
      expect(() => arrayInput(value, "items")).toThrow(DomainError);
      expect(() => canonical(value)).toThrow(DomainError);
    }
    expect(invoked).toBe(false);
    expect(() => arrayInput([1, 2], "items", 1, 2)).not.toThrow();
  });

  test("request boundary rejects sparse/accessor selections before evaluation", () => {
    const rig = new TestRig();
    try {
      let invoked = false;
      const accessor: unknown[] = [{ marketId: "market_0", side: "YES" }];
      Object.defineProperty(accessor, "0", {
        enumerable: true,
        get: () => {
          invoked = true;
          return { marketId: "market_0", side: "YES" };
        },
      });
      const before = rig.engine.snapshot();
      expect(() => rig.request({ legs: new Array(1) as never })).toThrow(
        DomainError,
      );
      expect(() => rig.request({ legs: accessor as never })).toThrow(
        DomainError,
      );
      expect(invoked).toBe(false);
      expect(rig.engine.snapshot()).toEqual(before);
      expect(rig.engine.audit().ok).toBe(true);
    } finally {
      rig.close();
    }
  });
});
