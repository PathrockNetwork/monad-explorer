import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeStakingEvent } from "../src/evm";
import { accessSet, callTree, dependencyGraph, summarizeCalls, type AccessSet } from "../src/trace";

const time = new Date("2026-10-20T00:00:00Z");
const fixture: { txHash: string; result: any }[] = JSON.parse(
  readFileSync(new URL("./fixtures/calltrace-0x6d8c47a.json", import.meta.url), "utf8"),
);

describe("summarizeCalls", () => {
  it("counts frames below the top level and keeps value-moving ones", () => {
    const root = {
      type: "CALL",
      from: "0xA",
      to: "0xB",
      value: "0x0",
      calls: [
        { type: "CALL", from: "0xB", to: "0xC", value: "0x0", calls: [{ type: "CALL", from: "0xC", to: "0xD", value: "0x5" }] },
        { type: "CREATE2", from: "0xB", to: "0xE", value: "0x0" },
        { type: "STATICCALL", from: "0xB", to: "0xF" },
        // Inherits msg.value without moving it: not an internal transfer.
        { type: "DELEGATECALL", from: "0xB", to: "0x10", value: "0x5" },
      ],
    };
    const s = summarizeCalls("0xtx", 1, time, root);
    expect(s.callCount).toBe(5);
    expect(s.callDepth).toBe(2);
    expect(s.internal.map((r) => [r.callType, r.to, r.value, r.depth, r.idx])).toEqual([
      ["CALL", "0xd", "5", 2, 2],
      ["CREATE2", "0xe", "0", 1, 3],
    ]);
  });

  it("reads real Monad callTracer output", () => {
    // tx 0 is the reward syscall: a single frame moving the block reward.
    const reward = summarizeCalls(fixture[0]!.txHash, 0x6d8c47a, time, fixture[0]!.result);
    expect(reward.callCount).toBe(0);
    expect(reward.internal).toEqual([]);
    const busy = summarizeCalls(fixture[1]!.txHash, 0x6d8c47a, time, fixture[1]!.result);
    expect(busy.callCount).toBe(13);
    const { frames, truncated } = callTree(fixture[2]!.result, 10);
    expect(frames).toBe(10);
    expect(truncated).toBe(true);
  });
});

describe("accessSet", () => {
  it("separates reads from writes and ignores the fee recipient", () => {
    const pre = {
      "0xSender": { balance: "0x10", nonce: 1 },
      "0xPool": { balance: "0x0", storage: { "0x01": "0x1", "0x02": "0x2" } },
      "0xMiner": { balance: "0x5" },
    };
    const diff = {
      pre: { "0xSender": { balance: "0x10", nonce: 1 }, "0xPool": { storage: { "0x01": "0x1" } }, "0xMiner": { balance: "0x5" } },
      post: { "0xSender": { balance: "0x8", nonce: 2 }, "0xPool": { storage: { "0x01": "0x9" } }, "0xMiner": { balance: "0x6" } },
    };
    const s = accessSet(pre, diff, new Set(["0xminer"]));
    expect([...s.reads].sort()).toEqual(["0xpool", "0xpool:0x01", "0xpool:0x02", "0xsender"]);
    expect([...s.writes].sort()).toEqual(["0xpool:0x01", "0xsender"]);
  });
});

describe("dependencyGraph", () => {
  const set = (reads: string[], writes: string[]): AccessSet => ({ reads: new Set(reads), writes: new Set(writes) });

  it("finds chains through shared state and leaves independent txs at level 0", () => {
    const g = dependencyGraph([
      set(["a"], ["pool:1"]), // 0
      set(["b"], ["b"]), // 1: independent
      set(["pool:1"], ["pool:1"]), // 2: depends on 0
      set(["pool:1"], []), // 3: depends on 2 (latest writer)
      set(["c"], ["c"]), // 4: independent
    ]);
    expect(g.levels).toEqual([0, 0, 1, 2, 0]);
    expect(g.edges).toEqual([
      [0, 2],
      [2, 3],
    ]);
    expect(g.criticalPath).toBe(3);
    expect(g.dependentTxs).toBe(2);
    expect(g.parallelism).toBeCloseTo(5 / 3);
    expect(g.hot[0]).toEqual({ address: "pool", edges: 2, txs: 3 });
  });

  it("treats an empty block as zero, not NaN", () => {
    expect(dependencyGraph([])).toMatchObject({ criticalPath: 0, parallelism: 0 });
  });
});

describe("decodeStakingEvent", () => {
  it("decodes a real Undelegate log", () => {
    const e = decodeStakingEvent({
      address: "0x0000000000000000000000000000000000001000",
      topics: [
        "0x3e53c8b91747e1b72a44894db10f2a45fa632b161fdcdd3a17bd6be5482bac62",
        "0x00000000000000000000000000000000000000000000000000000000000000bf",
        "0x0000000000000000000000001b68626dca36c7fe922fd2d55e4f631d962de19c",
      ],
      data:
        "0x0000000000000000000000000000000000000000000000000000000000000032" +
        "000000000000000000000000000000000000000000004af2dfd231e481a5a0ed" +
        "00000000000000000000000000000000000000000000000000000000000008fb",
      transactionHash: "0x9E27",
      logIndex: "0x3",
      blockNumber: "0x6d88d0b",
      blockTimestamp: "0x6ad69530",
    });
    expect(e).toMatchObject({
      kind: "undelegate",
      validatorId: 0xbf,
      address: "0x1b68626dca36c7fe922fd2d55e4f631d962de19c",
      withdrawId: 50,
      amount: BigInt("0x4af2dfd231e481a5a0ed").toString(),
      epoch: 0x8fb,
      txHash: "0x9e27",
      logIndex: 3,
    });
    expect(e?.time?.getTime()).toBe(0x6ad69530 * 1000);
  });

  it("ignores logs from other contracts and unknown topics", () => {
    expect(decodeStakingEvent({ address: "0x1", topics: ["0xe4d4df1e1827dd28252fd5c3cd7ebccd3da6e0aa31f74c828f3c8542af49d840"], data: "0x" })).toBeNull();
    expect(decodeStakingEvent({ address: "0x0000000000000000000000000000000000001000", topics: ["0x00"], data: "0x" })).toBeNull();
  });
});
