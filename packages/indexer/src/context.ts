/** Shared handles for the indexer's loops. */
import type { DbClient, JsonRpc } from "@monad-explorer/core";

export type Ctx = DbClient & {
  rpc: JsonRpc;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  stopping: () => boolean;
  /** Newest block ingested by the follower, and the chain's finalized height. */
  head: () => number | null;
  finalized: () => number;
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The follower counts as caught up within this many blocks of finalized. */
export const CAUGHT_UP_BLOCKS = 10;

export const caughtUp = (ctx: Ctx): boolean => {
  const h = ctx.head();
  return h !== null && ctx.finalized() - h <= CAUGHT_UP_BLOCKS;
};

export const toHex = (n: number) => `0x${n.toString(16)}`;
