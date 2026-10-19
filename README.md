# Monad Explorer

> Block explorer for Monad mainnet (chain 143), by Pathrock Network.

Follows finalized Monad blocks over JSON-RPC into Postgres and serves them through a REST API
and a React explorer with the same design as [secretnetwork-explorer](../secretnetwork-explorer)
(layout, components and CSS ported; Monad purple palette). Pages: Overview, Validators, Staking,
Blocks, Transactions (tx detail with call tree, gas analysis and state changes; address pages with
token transfers, internal transfers and delegations), Finality, Parallelism, Gas, Analytics,
Network (RPC endpoint health), RPC Console (browser-side Ethereum JSON-RPC), API Reference and
Settings.

The CometBFT/LCD/yaci layer of the Secret explorer is replaced by an EVM JSON-RPC indexer and
Monad's staking precompile.

## Stack
- TypeScript (Node 20+, ESM), pnpm workspaces
- PostgreSQL 16+
- Drizzle ORM · Fastify · React + Vite

## Layout
| Path | Responsibility |
|------|----------------|
| `packages/core` | DB schema + migrations, rate-limited JSON-RPC client with per-endpoint capability failover, pure decoding (`evm.ts`, `trace.ts`), staking precompile reads, trace fetching |
| `packages/indexer` | Follows `finalized` blocks, backfills/repairs gaps, retention sweep, token metadata, validators; plus `traces.ts` (sampled tracing + gas replay), `pipeline.ts` (MonadBFT stages over WebSocket), `history.ts` (staking events + reward repair over `eth_getLogs`), `rollup.ts` (hourly usage) |
| `packages/api` | Fastify REST API (`/api/v1/*`, Monad-specific views in `insights.ts`) and host for the built web app |
| `packages/web` | React explorer (Vite) |
| `deploy/` | systemd units and the Caddy site block |

## How data flows
- **Finalized only.** On Monad the `finalized` tag trails the tip by ~2 blocks (<1s), so the
  indexer never has to unwind a reorg.
- **Rolling window.** Monad produces ~3 blocks and ~50 txs per second (~4M rows/day), so
  Postgres keeps `RETAIN_HOURS` (default 72h). Blocks older than that are read through from
  the archive RPC (marked "via archive RPC" in the UI); transaction pages always come from RPC.
  Address history and counts cover the indexed window only.
- **Rate limits.** Public gateways allow ~50 req/s per IP. The indexer budgets 25 req/s and the
  API 15 req/s, and both fail over across `RPC_URLS`. Live following costs ~7 req/s, and
  backfill uses the remainder (~8 blocks/s).
- **Gas.** Monad charges for the gas *limit*; receipts report `gasUsed == gas`, so fee =
  gas limit × effective gas price.

## What is specific to Monad
Each view below exists because Monad works differently from Ethereum.

| View | Monad property | Source |
|------|----------------|--------|
| **Finality** (`#/live`) | MonadBFT moves each proposal through Proposed → Voted → Finalized, and asynchronous execution verifies its state root ~3 blocks later | `monadNewHeads` WebSocket subscription; first-seen time of each stage per `blockId` (`block_stages`). Live via server-sent events (`/api/v1/stream`). A proposal that never finalizes while a competing one at its height does is reported as **abandoned** and attributed to its proposer. |
| **Parallelism** (`#/parallel`, block detail) | Transactions execute optimistically in parallel; conflicting ones re-execute | `prestateTracer` (plain + `diffMode`) read/write sets per transaction → dependency graph, critical path, ideal speed-up, most contended contracts (`block_traces`). Conservative: account/slot granularity, fee recipient and reward syscall excluded. It is the structure a scheduler faces, not the node's own retry count (not published). |
| **Gas** (`#/gas`, tx detail) | The full gas **limit** is charged, not gas used | `eth_estimateGas` replayed on the parent block's state per transaction (`transactions.gas_estimate`); limit − estimate = unused gas. The estimate carries the estimator's headroom, so unused is understated, never inflated. |
| **Staking** (`#/staking`, validators, address pages) | Staking is a precompile with per-block rewards | Live `getDelegations`/`getDelegator`; `ValidatorRewarded` amounts (`blocks.reward`) give measured, annualised reward and delegator APR; delegate/undelegate/withdraw/claim/commission events (`staking_events`, never swept). |
| **Internal transfers** (tx and address pages) | — (generic, but needs tracing) | `callTracer`: value-moving inner CALL/CREATE/SELFDESTRUCT frames (`internal_txs`). |
| **Who uses Monad** (Analytics) | — | Hourly per-contract gas/tx/fee rollup (`usage_hourly`). |

**Sampling.** On the public RPC, tracing and gas replay run on every `TRACE_EVERY`-th block
(default 10) and the staking-history crawl moves 100 blocks per `eth_getLogs` call. Every view
says when it is sampled; single transactions and blocks are always traced on demand. A private
RPC removes the sampling: see the *Private RPC profile* in `.env.example`
(`TRACE_EVERY=1`, wider `STAKING_LOGS_RANGE`, `RETAIN_HOURS=0` + `BACKFILL_DEPTH=all` for full
history). `/api/v1/config` reports the active settings under `features`.

**Public RPC capabilities**, as observed: `rpc.monad.xyz` and `rpc2` allow `debug_trace*`
(`callTracer`, `prestateTracer`; no struct logger); `rpc3` refuses `debug_*` and small batches,
which the client learns and routes around. `eth_getLogs` is capped at 100 blocks; WebSocket
`monadNewHeads` is available on `rpc` and `rpc3`.

## Validators
- **State** comes from the staking precompile (`0x…1000`): validator sets, stake, commission,
  unclaimed rewards, synced every 5 minutes. The precompile's consensus/snapshot views swap
  meaning during the epoch delay period, so the API resolves them into `active_*` (this epoch)
  and `next_*` (next epoch) fields; use those, not the raw views.
- **Identity** (name, logo, website, X, VDP) comes from the official
  [validator-info registry](https://github.com/monad-developers/validator-info), refreshed every
  6 hours. An entry is only trusted when its id and SECP key match the chain. Logos are served
  through a same-origin proxy (`/api/v1/validators/:id/logo`) so visitors never contact
  third-party hosts.
- **Proposers** come from each block's `ValidatorRewarded` event. Blocks indexed before that
  existed are attributed through each validator's learned beneficiary (`miner`) address.
- **Proposal rate** (observed ÷ stake-expected proposals, over the newest fully attributed 50k
  blocks) stands in for Cosmos-style uptime, since Monad exposes no per-block signatures. It is
  an estimate and is null below 5 expected proposals. **Abandoned proposals** (from the
  pipeline) and **measured reward/delegator APR** (24h of block rewards) sit alongside it.

## Quickstart
```bash
pnpm install
cp .env.example .env          # set DATABASE_URL
sudo -u postgres psql -c "create role monad login password '…'" -c "create database monad_explorer owner monad"
pnpm db:migrate
pnpm --filter @monad-explorer/web build
pnpm dev                      # indexer + API; explorer on http://127.0.0.1:3001
pnpm test
```

## Running as a service
```bash
sudo cp deploy/monad-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now monad-indexer monad-api
journalctl -u monad-indexer -f     # progress line every 30s
```

## Public access (no domain)
The API binds `127.0.0.1:3001`. Caddy publishes it read-only on port 8080 over plain HTTP:
```bash
sudo cp deploy/Caddyfile.monad /etc/caddy/monad.caddy
echo 'import monad.caddy' | sudo tee -a /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
Open `http://<server-ip>:8080`. When a domain exists, replace `:8080` in `monad.caddy` with
the hostname and Caddy will obtain a TLS certificate automatically.

## Not yet built
- Contract verification and ABI decoding.
- Node-local data: Monad's execution-events stream (exact per-transaction storage access and
  re-execution) and consensus internals (round timeouts, votes per validator) are only
  available on the node's own host. They need a small companion service next to your node.
- Full history is supported (`RETAIN_HOURS=0`, `BACKFILL_DEPTH=all`) but not enabled: from
  genesis it is hundreds of millions of rows and needs a private RPC and much more disk.
