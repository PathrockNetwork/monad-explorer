import type { TokenMeta, Transfer, Tx } from "./api";
import { formatUnits, STAKING_PRECOMPILE } from "./lib";

export const transactionCategories = ["All", "Transfers", "Contract calls", "Creates", "Failed", "Staking"] as const;
export type TransactionCategory = typeof transactionCategories[number];
/** The kind a transaction is, from its shape alone. "Failed" is a status filter, not a kind. */
export type TransactionKind = "Transfers" | "Contract calls" | "Creates" | "Staking";

const TRANSFER_SELECTORS = new Set(["0xa9059cbb", "0x23b872dd"]);

type TxShape = Pick<Tx, "to" | "method" | "input_size">;

/** Derived client-side: there is no decoded intent, only the destination and 4-byte selector. */
export function transactionKind(tx: TxShape): TransactionKind {
  if (!tx.to) return "Creates";
  if (tx.to === STAKING_PRECOMPILE) return "Staking";
  if ((!tx.method && !tx.input_size) || (tx.method && TRANSFER_SELECTORS.has(tx.method))) return "Transfers";
  return "Contract calls";
}

export type TransactionFilters = { query: string; category: TransactionCategory; status: string; method: string };
export const defaultTransactionFilters: TransactionFilters = { query: "", category: "All", status: "all", method: "all" };

export function filterTransactions(rows: Tx[], filters: TransactionFilters, label: (tx: Tx) => string) {
  const query = filters.query.trim().toLowerCase().replace(/,/g, "");
  return rows.filter((tx) =>
    (!query || [tx.hash, tx.from, tx.to, tx.contract_address, tx.method, label(tx), String(tx.block_number)].some((value) => value?.toLowerCase().includes(query))) &&
    (filters.category === "All" || (filters.category === "Failed" ? tx.status === 0 : transactionKind(tx) === filters.category)) &&
    (filters.status === "all" || (filters.status === "success" ? tx.status === 1 : tx.status === 0)) &&
    (filters.method === "all" || label(tx) === filters.method));
}

/** Fees in MON for the sparkline; zero-gas system calls are not fees anyone paid. */
export function paidFees(rows: Tx[]): bigint[] {
  return rows.flatMap((tx) => (/^\d+$/.test(tx.fee) && tx.fee !== "0" ? [BigInt(tx.fee)] : []));
}

export const weiToNumber = (wei: bigint) => Number(wei / 10n ** 9n) / 1e9;

/** Cursor for the page after `rows`: the "block:index" of its last row. */
export const txCursor = (tx: Pick<Tx, "block_number" | "tx_index">) => `${tx.block_number}:${tx.tx_index}`;

/**
 * Token amount for display. ERC-721 values are token ids; ERC-20 amounts use
 * the token's decimals, and when those are unknown the raw integer is shown.
 */
export function tokenAmount(value: string, standard: Transfer["standard"], meta: TokenMeta | null): { text: string; raw: boolean; nft: boolean } {
  if (standard === "erc721") return { text: `#${value}`, raw: false, nft: true };
  if (meta?.decimals == null) return { text: value, raw: true, nft: false };
  return { text: formatUnits(value, meta.decimals, 6), raw: false, nft: false };
}

export type Direction = "in" | "out" | "self";
export function direction(from: string, to: string | null, address: string): Direction {
  const f = from.toLowerCase() === address, t = (to ?? "").toLowerCase() === address;
  return f && t ? "self" : f ? "out" : "in";
}

/** What a search box was given, decided from its shape alone. */
export type SearchTarget =
  | { kind: "transaction"; hash: string }
  | { kind: "address"; address: string }
  | { kind: "block"; height: number }
  | { kind: "text"; query: string };

export function searchTarget(input: string): SearchTarget | null {
  const q = input.trim();
  if (!q) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return { kind: "transaction", hash: q.toLowerCase() };
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { kind: "address", address: q.toLowerCase() };
  if (/^\d{1,12}$/.test(q) && Number(q) > 0) return { kind: "block", height: Number(q) };
  return { kind: "text", query: q };
}

export const addressRoute = (address: string) => `#/transactions/address/${address.toLowerCase()}`;
export const txRoute = (hash: string) => `#/transactions/${hash.toLowerCase()}`;

/** `#/transactions/address/<0x addr>` → lowercase addr, else null. */
export function addressFromHash(hash: string): string | null {
  return hash.match(/^#\/transactions\/address\/(0x[0-9a-fA-F]{40})$/)?.[1]?.toLowerCase() ?? null;
}

/** `#/transactions/<0x tx hash>` → lowercase hash, else null. */
export function txHashFromHash(hash: string): string | null {
  return hash.match(/^#\/transactions\/(0x[0-9a-fA-F]{64})$/)?.[1]?.toLowerCase() ?? null;
}
