/**
 * Pure EVM decoding helpers: raw JSON-RPC block + receipts → table rows.
 * No I/O here, so it is the unit-tested core of the indexer.
 */

/** keccak256("Transfer(address,address,uint256)") — shared by ERC-20 and ERC-721. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * keccak256("ValidatorRewarded(uint64,address,uint256,uint64)"), emitted by the
 * staking precompile in every block's reward syscall. topic1 is the proposer's
 * validator id — the only on-chain link from a block to its validator, since
 * the header's `miner` is a beneficiary address the operator chooses.
 */
export const VALIDATOR_REWARDED_TOPIC = "0x3a420a01486b6b28d6ae89c51f5c3bde3e0e74eecbb646a0c481ccba3aae3754";
const STAKING_ADDRESS = "0x0000000000000000000000000000000000001000";

/** topic0 → kind for every other staking precompile event (see stakingEvents). */
export const STAKING_EVENT_TOPICS: Record<string, StakingEventRow["kind"]> = {
  "0xe4d4df1e1827dd28252fd5c3cd7ebccd3da6e0aa31f74c828f3c8542af49d840": "delegate", // Delegate(uint64,address,uint256,uint64)
  "0x3e53c8b91747e1b72a44894db10f2a45fa632b161fdcdd3a17bd6be5482bac62": "undelegate", // Undelegate(uint64,address,uint8,uint256,uint64)
  "0x63030e4238e1146c63f38f4ac81b2b23c8be28882e68b03f0887e50d0e9bb18f": "withdraw", // Withdraw(uint64,address,uint8,uint256,uint64)
  "0xcb607e6b63c89c95f6ae24ece9fe0e38a7971aa5ed956254f1df47490921727b": "claim", // ClaimRewards(uint64,address,uint256,uint64)
  "0xd1698d3454c5b5384b70aaae33f1704af7c7e055f0c75503ba3146dc28995920": "commission", // CommissionChanged(uint64,uint256,uint256)
  "0x6f8045cd38e512b8f12f6f02947c632e5f25af03aad132890ecf50015d97c1b2": "created", // ValidatorCreated(uint64,address,uint256)
  "0xc95966754e882e03faffaf164883d98986dda088d09471a35f9e55363daf0c53": "status", // ValidatorStatusChanged(uint64,uint64)
  "0x4fae4dbe0ed659e8ce6637e3c273cd8e4d3bf029b9379a9e8b3f3f27dbef809b": "epoch", // EpochChanged(uint64,uint64)
};

export const MON_DECIMALS = 18;

export const hexToNumber = (h: string | null | undefined): number => (h ? Number.parseInt(h, 16) : 0);
export const hexToBig = (h: string | null | undefined): bigint => (h && h !== "0x" ? BigInt(h) : 0n);

/** Last 20 bytes of a 32-byte topic, as a lowercase address. */
export const topicToAddress = (topic: string): string => `0x${topic.slice(-40)}`.toLowerCase();

export const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isHash = (s: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(s);

export type BlockRow = {
  number: number;
  hash: string;
  parentHash: string;
  time: Date;
  miner: string;
  gasUsed: number;
  gasLimit: number;
  baseFeePerGas: string | null;
  txCount: number;
  size: number | null;
  /** Proposer's validator id from the reward event; null if the block had none. */
  proposerId: number | null;
  /** Reward amount from the same event, wei. */
  reward: string | null;
};

export type TxRow = {
  hash: string;
  blockNumber: number;
  txIndex: number;
  time: Date;
  from: string;
  to: string | null;
  contractAddress: string | null;
  value: string;
  nonce: number;
  type: number;
  gasLimit: number;
  gasUsed: number;
  effectiveGasPrice: string;
  fee: string;
  status: number;
  method: string | null;
  inputSize: number;
  logCount: number;
};

export type TransferRow = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  time: Date;
  token: string;
  from: string;
  to: string;
  value: string;
  standard: "erc20" | "erc721";
};

export type StakingEventRow = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  time: Date | null;
  kind: "delegate" | "undelegate" | "withdraw" | "claim" | "commission" | "created" | "status" | "epoch";
  validatorId: number | null;
  address: string | null;
  amount: string | null;
  epoch: number | null;
  withdrawId: number | null;
  oldCommission: number | null;
  newCommission: number | null;
  flags: number | null;
};

export type ParsedBlock = { block: BlockRow; txs: TxRow[]; transfers: TransferRow[]; staking: StakingEventRow[] };

/** 32-byte words of a log's data field. */
const words = (data: string): bigint[] => {
  const hex = (data ?? "0x").slice(2);
  return Array.from({ length: Math.floor(hex.length / 64) }, (_, i) => BigInt(`0x${hex.slice(i * 64, i * 64 + 64)}`));
};

/**
 * Decode a staking precompile event (other than ValidatorRewarded). `time`
 * defaults to the log's `blockTimestamp`, which Monad's eth_getLogs includes.
 */
export function decodeStakingEvent(log: any, time: Date | null = null): StakingEventRow | null {
  if (String(log.address).toLowerCase() !== STAKING_ADDRESS) return null;
  const topics: string[] = log.topics ?? [];
  const kind = STAKING_EVENT_TOPICS[topics[0]?.toLowerCase() ?? ""];
  if (!kind) return null;
  const w = words(log.data);
  const row: StakingEventRow = {
    txHash: String(log.transactionHash).toLowerCase(),
    logIndex: hexToNumber(log.logIndex),
    blockNumber: hexToNumber(log.blockNumber),
    time: time ?? (log.blockTimestamp ? new Date(hexToNumber(log.blockTimestamp) * 1000) : null),
    kind,
    validatorId: topics[1] ? Number(hexToBig(topics[1])) : null,
    address: topics[2] ? topicToAddress(topics[2]) : null,
    amount: null,
    epoch: null,
    withdrawId: null,
    oldCommission: null,
    newCommission: null,
    flags: null,
  };
  const num = (x: bigint | undefined) => (x === undefined ? null : Number(x));
  const frac = (x: bigint | undefined) => (x === undefined ? null : Number(x) / 1e18);
  switch (kind) {
    case "delegate":
    case "claim":
      row.amount = w[0]?.toString() ?? null;
      row.epoch = num(w[1]);
      break;
    case "undelegate":
    case "withdraw":
      row.withdrawId = num(w[0]);
      row.amount = w[1]?.toString() ?? null;
      row.epoch = num(w[2]);
      break;
    case "commission":
      row.oldCommission = frac(w[0]);
      row.newCommission = frac(w[1]);
      break;
    case "created":
      row.newCommission = frac(w[0]);
      break;
    case "status":
      row.flags = num(w[0]);
      break;
    case "epoch":
      row.validatorId = null;
      row.epoch = num(w[1]);
      break;
  }
  return row;
}

/**
 * Decode a `Transfer` log. ERC-20 carries the amount in data (3 topics);
 * ERC-721 indexes the token id (4 topics). Anything else sharing the topic
 * (malformed or non-standard emitters) is skipped rather than guessed at.
 */
export function decodeTransfer(log: any): Omit<TransferRow, "txHash" | "blockNumber" | "time"> | null {
  const topics: string[] = log.topics ?? [];
  if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  const base = { logIndex: hexToNumber(log.logIndex), token: String(log.address).toLowerCase() };
  if (topics.length === 3 && typeof log.data === "string" && log.data.length === 66) {
    return { ...base, from: topicToAddress(topics[1]!), to: topicToAddress(topics[2]!), value: hexToBig(log.data).toString(), standard: "erc20" };
  }
  if (topics.length === 4) {
    return { ...base, from: topicToAddress(topics[1]!), to: topicToAddress(topics[2]!), value: hexToBig(topics[3]).toString(), standard: "erc721" };
  }
  return null;
}

/**
 * Join `eth_getBlockByNumber(n, true)` with `eth_getBlockReceipts(n)`.
 * Receipts are matched by hash, not position, and a missing receipt throws:
 * persisting a transaction without its status and gas would be silently wrong.
 */
export function parseBlock(rawBlock: any, rawReceipts: any[]): ParsedBlock {
  const number = hexToNumber(rawBlock.number);
  const time = new Date(hexToNumber(rawBlock.timestamp) * 1000);
  const receipts = new Map<string, any>(rawReceipts.map((r) => [String(r.transactionHash).toLowerCase(), r]));

  const txs: TxRow[] = [];
  const transfers: TransferRow[] = [];
  const staking: StakingEventRow[] = [];
  let proposerId: number | null = null;
  let reward: string | null = null;
  for (const tx of rawBlock.transactions as any[]) {
    const hash = String(tx.hash).toLowerCase();
    const rc = receipts.get(hash);
    if (!rc) throw new Error(`block ${number}: no receipt for ${hash}`);
    const gasUsed = hexToBig(rc.gasUsed);
    const price = hexToBig(rc.effectiveGasPrice ?? tx.gasPrice);
    const input: string = tx.input ?? "0x";
    const logs: any[] = rc.logs ?? [];
    txs.push({
      hash,
      blockNumber: number,
      txIndex: hexToNumber(tx.transactionIndex),
      time,
      from: String(tx.from).toLowerCase(),
      to: tx.to ? String(tx.to).toLowerCase() : null,
      contractAddress: rc.contractAddress ? String(rc.contractAddress).toLowerCase() : null,
      value: hexToBig(tx.value).toString(),
      nonce: hexToNumber(tx.nonce),
      type: hexToNumber(tx.type),
      gasLimit: hexToNumber(tx.gas),
      gasUsed: Number(gasUsed),
      effectiveGasPrice: price.toString(),
      fee: (gasUsed * price).toString(),
      status: hexToNumber(rc.status),
      method: input.length >= 10 ? input.slice(0, 10).toLowerCase() : null,
      inputSize: Math.max(0, (input.length - 2) / 2),
      logCount: logs.length,
    });
    for (const log of logs) {
      if (
        proposerId === null &&
        String(log.address).toLowerCase() === STAKING_ADDRESS &&
        log.topics?.[0]?.toLowerCase() === VALIDATOR_REWARDED_TOPIC &&
        log.topics[1]
      ) {
        proposerId = Number(hexToBig(log.topics[1]));
        reward = words(log.data)[0]?.toString() ?? null;
        continue;
      }
      const se = decodeStakingEvent(log, time);
      if (se) {
        staking.push(se);
        continue;
      }
      const t = decodeTransfer(log);
      if (t) transfers.push({ ...t, txHash: hash, blockNumber: number, time });
    }
  }

  return {
    block: {
      number,
      hash: String(rawBlock.hash).toLowerCase(),
      parentHash: String(rawBlock.parentHash).toLowerCase(),
      time,
      miner: String(rawBlock.miner).toLowerCase(),
      gasUsed: hexToNumber(rawBlock.gasUsed),
      gasLimit: hexToNumber(rawBlock.gasLimit),
      baseFeePerGas: rawBlock.baseFeePerGas ? hexToBig(rawBlock.baseFeePerGas).toString() : null,
      txCount: (rawBlock.transactions as any[]).length,
      size: rawBlock.size ? hexToNumber(rawBlock.size) : null,
      proposerId,
      reward,
    },
    txs,
    transfers,
    staking,
  };
}

/**
 * Decode an eth_call result for `name()` / `symbol()`. Standard tokens return
 * an ABI-encoded string; some early ones (MKR-style) return bytes32. Returns
 * null for anything that is neither, and strips control characters so a
 * hostile token cannot inject markup-looking junk into the UI.
 */
export function decodeAbiString(hex: string | null | undefined): string | null {
  if (!hex || hex === "0x") return null;
  const data = hex.slice(2);
  try {
    let text: string;
    if (data.length === 64) {
      text = Buffer.from(data, "hex").toString("utf8").replace(/\0+$/, "");
    } else {
      if (data.length < 128) return null;
      const offset = Number.parseInt(data.slice(0, 64), 16) * 2;
      const len = Number.parseInt(data.slice(offset, offset + 64), 16);
      if (!Number.isFinite(len) || len > 256) return null;
      text = Buffer.from(data.slice(offset + 64, offset + 64 + len * 2), "hex").toString("utf8");
    }
    const clean = text.replace(/[\u0000-\u001f\u007f�]/g, "").trim();
    return clean ? clean.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/** Decode a uint8 `decimals()` result; null when absent or implausible. */
export function decodeDecimals(hex: string | null | undefined): number | null {
  if (!hex || hex === "0x" || hex.length !== 66) return null;
  const n = hexToBig(hex);
  return n <= 36n ? Number(n) : null;
}

/** Format a wei-like integer string with `decimals`, trimming trailing zeros. */
export function formatUnits(value: string | bigint, decimals = MON_DECIMALS, maxFraction = 6): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${wholeStr}${frac ? `.${frac}` : ""}`;
}
