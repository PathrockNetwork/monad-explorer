import { describe, expect, it } from "vitest";
import { TRANSFER_TOPIC, decodeAbiString, decodeDecimals, decodeTransfer, formatUnits, parseBlock } from "../src/evm";

const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const TOKEN = "0x" + "CC".repeat(20);

describe("decodeTransfer", () => {
  it("decodes ERC-20 (amount in data)", () => {
    const t = decodeTransfer({ address: TOKEN, logIndex: "0x2", topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: pad("3e8") });
    expect(t).toEqual({ logIndex: 2, token: TOKEN.toLowerCase(), from: A, to: B, value: "1000", standard: "erc20" });
  });

  it("decodes ERC-721 (token id in topic 3)", () => {
    const t = decodeTransfer({ address: TOKEN, logIndex: "0x0", topics: [TRANSFER_TOPIC, pad(A), pad(B), pad("7")], data: "0x" });
    expect(t?.standard).toBe("erc721");
    expect(t?.value).toBe("7");
  });

  it("skips other events and malformed transfers", () => {
    expect(decodeTransfer({ address: TOKEN, logIndex: "0x0", topics: [pad("1"), pad(A), pad(B)], data: pad("1") })).toBeNull();
    expect(decodeTransfer({ address: TOKEN, logIndex: "0x0", topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: "0x" })).toBeNull();
  });
});

describe("parseBlock", () => {
  const rawBlock = {
    number: "0x10",
    hash: "0xH",
    parentHash: "0xP",
    timestamp: "0x6ad49f63",
    miner: A.toUpperCase().replace("0X", "0x"),
    gasUsed: "0x5208",
    gasLimit: "0x8f0d180",
    baseFeePerGas: "0x174876e800",
    size: "0x320",
    transactions: [
      { hash: "0xT1", transactionIndex: "0x0", from: A, to: B, value: "0xde0b6b3a7640000", nonce: "0x1", type: "0x2", gas: "0x5208", input: "0x" },
      { hash: "0xT2", transactionIndex: "0x1", from: B, to: null, value: "0x0", nonce: "0x0", type: "0x2", gas: "0x100000", input: "0xa9059cbb0000" },
    ],
  };
  const receipts = [
    { transactionHash: "0xt2", status: "0x0", gasUsed: "0x10", effectiveGasPrice: "0x2", contractAddress: TOKEN, logs: [] },
    {
      transactionHash: "0xT1",
      status: "0x1",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x174876e800",
      logs: [{ address: TOKEN, logIndex: "0x0", topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: pad("5") }],
    },
  ];

  it("joins receipts by hash regardless of order", () => {
    const p = parseBlock(rawBlock, receipts);
    expect(p.block).toMatchObject({ number: 16, txCount: 2, miner: A, baseFeePerGas: "100000000000" });
    expect(p.txs[0]).toMatchObject({ hash: "0xt1", status: 1, value: "1000000000000000000", fee: (21000n * 100000000000n).toString(), method: null });
    expect(p.txs[1]).toMatchObject({ status: 0, to: null, contractAddress: TOKEN.toLowerCase(), method: "0xa9059cbb", inputSize: 6, fee: "32" });
    expect(p.transfers).toHaveLength(1);
    expect(p.transfers[0]).toMatchObject({ txHash: "0xt1", blockNumber: 16, value: "5" });
  });

  it("refuses a block with a missing receipt", () => {
    expect(() => parseBlock(rawBlock, receipts.slice(0, 1))).toThrow(/no receipt/);
  });
});

describe("token metadata decoding", () => {
  it("decodes ABI strings and bytes32 names", () => {
    const abi = "0x" + pad("20").slice(2) + pad("4").slice(2) + Buffer.from("WMON").toString("hex").padEnd(64, "0");
    expect(decodeAbiString(abi)).toBe("WMON");
    expect(decodeAbiString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0"))).toBe("MKR");
    expect(decodeAbiString("0x")).toBeNull();
  });

  it("strips control characters", () => {
    const abi = "0x" + pad("20").slice(2) + pad("3").slice(2) + "410a42".padEnd(64, "0");
    expect(decodeAbiString(abi)).toBe("AB");
  });

  it("decodes decimals and rejects implausible values", () => {
    expect(decodeDecimals(pad("12"))).toBe(18);
    expect(decodeDecimals(pad("ff"))).toBeNull();
    expect(decodeDecimals("0x")).toBeNull();
  });
});

describe("formatUnits", () => {
  it("formats MON amounts", () => {
    expect(formatUnits("1000000000000000000")).toBe("1");
    expect(formatUnits("1234567890000000000000")).toBe("1,234.56789");
    expect(formatUnits("1", 18)).toBe("0");
    expect(formatUnits("5", 0)).toBe("5");
  });
});

describe("proposer attribution", () => {
  it("reads the proposer id from the staking precompile's ValidatorRewarded event", async () => {
    const { VALIDATOR_REWARDED_TOPIC } = await import("../src/evm");
    const block = { number: "0x1", hash: "0xh", parentHash: "0xp", timestamp: "0x1", miner: A, gasUsed: "0x0", gasLimit: "0x1", transactions: [{ hash: "0xs", transactionIndex: "0x0", from: B, to: "0x0000000000000000000000000000000000001000", value: "0x0", nonce: "0x0", type: "0x0", gas: "0x0", input: "0x791bdcf3" }] };
    const receipts = [{ transactionHash: "0xs", status: "0x1", gasUsed: "0x0", effectiveGasPrice: "0x0", logs: [{ address: "0x0000000000000000000000000000000000001000", logIndex: "0x0", topics: [VALIDATOR_REWARDED_TOPIC, pad("2a"), pad(B)], data: "0x" }] }];
    expect(parseBlock(block, receipts).block.proposerId).toBe(42);
    expect(parseBlock({ ...block, transactions: [] }, []).block.proposerId).toBeNull();
  });
});
