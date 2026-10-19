/** Routes implemented by this explorer's REST API (packages/api), not upstream JSON-RPC methods. */
export type ApiParameter = { name: string; location: "path" | "query"; description: string; default?: string; min?: number; max?: number; choices?: string[]; pattern?: RegExp; required?: boolean };
export type ApiEndpoint = { id: string; method: "GET"; path: string; title: string; description: string; response: string; category: string; tags: string[]; overview?: boolean; parameters?: ApiParameter[]; binary?: boolean };

const limit: ApiParameter = { name: "limit", location: "query", default: "25", min: 1, max: 100, description: "Rows returned (1–100, default 25)." };
const blockId: ApiParameter = { name: "id", location: "path", pattern: /^(\d+|0x[0-9a-fA-F]{64})$/, description: "Block number, or a 0x-prefixed 32-byte block hash." };
const validatorId: ApiParameter = { name: "id", location: "path", min: 0, max: Number.MAX_SAFE_INTEGER, description: "On-chain validator id (non-negative integer)." };

export const API_BASE = "/api/v1";
export const API_CATEGORIES = ["Overview", "Network", "Blocks", "Transactions", "Addresses", "Validators", "Staking", "Consensus", "Execution", "Analytics", "Service"];
export const API_ENDPOINTS: ApiEndpoint[] = [
  { id: "stats", method: "GET", path: "/api/v1/stats", title: "Network snapshot", category: "Network", tags: ["network", "indexer"], overview: true,
    description: "Indexer head, chain finalized height and lag, cadence, TPS, 24 h totals, gas price, epoch, validator counts, total stake and per-minute activity for the last 30 minutes.",
    response: "Object: chain_id, indexed_head, chain_finalized, lag_blocks, avg_block_time_ms, tps, blocks_24h, txs_24h, gas_price (wei), epoch, validators_active, total_stake (wei), recent_minutes[], rpc[]." },
  { id: "endpoints", method: "GET", path: "/api/v1/endpoints", title: "RPC endpoint health", category: "Network", tags: ["network", "rpc"],
    description: "Server-side probe of each configured Monad RPC endpoint (eth_blockNumber, web3_clientVersion, eth_chainId), cached for 15 seconds.",
    response: "Object: indexer_rpc, chain_finalized, endpoints[] { url, healthy, latency_ms, height, client, error, priority, used_by_indexer }, api_rpc[]." },
  { id: "config", method: "GET", path: "/api/v1/config", title: "Deployment configuration", category: "Network", tags: ["network", "configuration"],
    description: "Chain identity, configured RPC endpoints (credentials redacted), indexer retention and backfill settings, and the validator registry source.",
    response: "Object: chain { name, network, chain_id, currency }, rpc_endpoints[], indexer { head, retain_hours, backfill_depth, database }, validator_registry, metric_hours[], features { full_history, trace_every, gas_replay, staking_history, staking_logs_range, pipeline }." },
  { id: "blocks", method: "GET", path: "/api/v1/blocks", title: "Recent blocks", category: "Blocks", tags: ["blocks", "pagination"], overview: true,
    parameters: [limit, { name: "before", location: "query", min: 1, max: Number.MAX_SAFE_INTEGER, description: "Return blocks with a number below this (pagination cursor). Past the indexed window, blocks are read from RPC." }],
    description: "Newest finalized blocks, newest first, with proposer attribution where known.",
    response: "Object: source (\"db\" or \"rpc\"), blocks[] { number, hash, time, miner, gas_used, gas_limit, base_fee_per_gas, tx_count, proposer_id, proposer_name }." },
  { id: "block", method: "GET", path: "/api/v1/blocks/:id", title: "Block details", category: "Blocks", tags: ["blocks"], overview: true, parameters: [blockId],
    description: "One block with all of its transactions. Blocks outside the indexed window are read through from RPC.",
    response: "Object: source, block { …same fields as the list }, txs[] (transaction rows). 404 when the block does not exist." },
  { id: "txs", method: "GET", path: "/api/v1/txs", title: "Recent transactions", category: "Transactions", tags: ["transactions", "pagination"], overview: true,
    parameters: [limit, { name: "before", location: "query", pattern: /^\d+:\d+$/, description: "Cursor \"block:index\" of the previous page's last row." }, { name: "address", location: "query", pattern: /^0x[0-9a-fA-F]{40}$/, description: "Only transactions sent from or to this 0x address." }],
    description: "Indexed transactions, newest first. Amounts and fees are wei strings.",
    response: "Object: source, txs[] { hash, block_number, tx_index, time, from, to, contract_address, value, gas_used, effective_gas_price, fee, status, method, log_count }." },
  { id: "tx", method: "GET", path: "/api/v1/txs/:hash", title: "Transaction details", category: "Transactions", tags: ["transactions", "receipt"], overview: true,
    parameters: [{ name: "hash", location: "path", pattern: /^0x[0-9a-fA-F]{64}$/, description: "0x-prefixed 32-byte transaction hash." }],
    description: "Transaction and receipt fetched live from RPC, with decoded ERC-20/721 transfers and raw logs.",
    response: "Object: source, tx { …, pending, confirmations, input }, transfers[], logs[]. 404 when unknown." },
  { id: "address", method: "GET", path: "/api/v1/address/:addr", title: "Address summary", category: "Addresses", tags: ["address", "balance"], overview: true,
    parameters: [{ name: "addr", location: "path", pattern: /^0x[0-9a-fA-F]{40}$/, description: "0x-prefixed 20-byte address." }],
    description: "Live balance, nonce and code size from RPC, plus token metadata, validator role and capped activity counts from the indexed window.",
    response: "Object: address, balance (wei), nonce, is_contract, code_size, token, validator, window { sent, received, count_cap, blocks_proposed }, transfers[]." },
  { id: "search", method: "GET", path: "/api/v1/search", title: "Search", category: "Addresses", tags: ["search"],
    parameters: [{ name: "q", location: "query", required: true, default: "", description: "Block number, transaction or block hash, or address." }],
    description: "Resolve free text to the page that shows it.",
    response: "Object: type (\"block\" | \"tx\" | \"address\") and id. 400 for unrecognised input, 404 for an unknown hash." },
  { id: "validators", method: "GET", path: "/api/v1/validators", title: "Validator list", category: "Validators", tags: ["validators", "staking"], overview: true,
    description: "Validators from the staking precompile and the validator-info registry, with stake, commission, set membership and proposal counts.",
    response: "Object: epoch, total_consensus_stake (wei), window, network_apr, count, active, validators[] { id, name, active_stake, active_commission, next_stake, in_consensus_set, stake_share, proposed_window, proposal_ratio, reward_apr, delegator_apr, abandoned_24h, … }." },
  { id: "validator", method: "GET", path: "/api/v1/validators/:id", title: "Validator details", category: "Validators", tags: ["validators"], parameters: [validatorId],
    description: "One validator with its 25 most recent proposed blocks and hourly proposal counts over the last 24 hours.",
    response: "Object: validator { … }, epoch, recent_blocks[], hourly[] { t, n }. 404 when unknown." },
  { id: "logo", method: "GET", path: "/api/v1/validators/:id/logo", title: "Validator logo", category: "Validators", tags: ["validators", "image"], parameters: [validatorId], binary: true,
    description: "Same-origin proxy for the registry logo. Images up to 2 MB are passed through (SVG under a sandboxing CSP); cached for an hour.",
    response: "Image bytes (png, jpeg, gif, webp, avif or svg). 404 JSON when the validator has no usable logo." },
  { id: "metrics", method: "GET", path: "/api/v1/metrics", title: "Analytics", category: "Analytics", tags: ["analytics", "metrics"], overview: true,
    parameters: [{ name: "hours", location: "query", default: "24", choices: ["1", "6", "24", "72"], description: "Trailing horizon in hours, within the rolling retention window." }],
    description: "Window totals, per-bucket TPS, average block time and gas utilization, and the top proposers. Buckets are 1 min, 5 min, 15 min or 1 h depending on the horizon.",
    response: "Object: hours, allowed_hours[], bucket_secs, stats { blocks, txs, avg_block_time_ms, tps, gas_utilization, max_txs_in_block }, series[], proposers[] { id, name, n, share }." },
  { id: "series", method: "GET", path: "/api/v1/series", title: "Activity series", category: "Analytics", tags: ["analytics", "series"],
    parameters: [{ name: "hours", location: "query", default: "1", min: 1, max: 72, description: "Trailing window in hours (1–72)." }],
    description: "Blocks, transactions and gas used per time bucket, straight from the block table.",
    response: "Object: hours, bucket_secs, points[] { t, blocks, txs, gas }." },
  { id: "tx-trace", method: "GET", path: "/api/v1/txs/:hash/trace", title: "Transaction trace", category: "Execution", tags: ["trace", "gas", "internal transactions", "state"], overview: true,
    parameters: [{ name: "hash", location: "path", pattern: /^0x[0-9a-fA-F]{64}$/, description: "0x-prefixed 32-byte transaction hash." }],
    description: "Call tree, value-moving internal calls, state diff and gas analysis for one transaction, traced on demand (debug_traceTransaction) and cached. Monad charges the full gas limit; gas.estimate is eth_estimateGas replayed on the parent block, so gas.unused is a conservative figure.",
    response: "Object: hash, block_number, call_count, call_depth, tree { type, from, to, value, gasUsed, method, error, calls[] }, internal[], gas { limit, estimate, unused, unused_fee (wei), efficiency, source }, state[] { address, balance_before, balance_after, storage_changes, … }, labels." },
  { id: "block-parallelism", method: "GET", path: "/api/v1/blocks/:n/parallelism", title: "Block dependency graph", category: "Execution", tags: ["parallel execution", "blocks"], overview: true,
    parameters: [{ name: "n", location: "path", min: 1, max: Number.MAX_SAFE_INTEGER, description: "Block number." }],
    description: "Dependency graph between a block's transactions from prestateTracer read/write sets: tx j depends on an earlier tx i when it reads or overwrites state i wrote. Indexed for sampled blocks, traced on demand otherwise.",
    response: "Object: block_number, source (\"indexed\" | \"traced\"), tx_count, dependent_txs, edges, critical_path, parallelism, levels[], edge_list[[from, to]], hot[] { address, edges, txs }, txs[], labels." },
  { id: "parallelism", method: "GET", path: "/api/v1/parallelism", title: "Parallelism over time", category: "Execution", tags: ["parallel execution", "analytics"],
    parameters: [{ name: "hours", location: "query", default: "6", min: 1, max: 168, description: "Trailing window in hours." }],
    description: "Average and median parallelism, critical path, dependent share and the most contended contracts over the traced sample (every trace_every-th block).",
    response: "Object: hours, trace_every, totals { traced_blocks, blocks, parallelism, median_parallelism, critical_path, dependent_share, internal_txs }, series[], critical_path_histogram[], hot[], extremes[]." },
  { id: "gas", method: "GET", path: "/api/v1/gas", title: "Gas overpayment", category: "Execution", tags: ["gas", "fees", "analytics"],
    parameters: [{ name: "hours", location: "query", default: "24", min: 1, max: 168, description: "Trailing window in hours." }],
    description: "What senders paid for and never used: gas limit minus replayed estimate, priced at the paid gas price, over replayed transactions. extrapolated_unused_fee scales the sample to every transaction in the window.",
    response: "Object: hours, trace_every, totals { sampled_txs, all_txs, gas_paid, gas_needed, unused_fee, efficiency, extrapolated_unused_fee }, by_contract[], by_sender[], efficiency_histogram[], series[]." },
  { id: "usage", method: "GET", path: "/api/v1/usage", title: "Chain usage", category: "Analytics", tags: ["usage", "contracts", "gas"],
    parameters: [{ name: "hours", location: "query", default: "24", min: 1, max: 168, description: "Trailing window in hours." }],
    description: "Top contracts by gas consumed, with transactions, fees and success rate, from an hourly rollup; plus base fee and block fullness per bucket.",
    response: "Object: hours, totals { txs, gas, contracts, fees, success, creations, since }, contracts[] { address, txs, gas, share, fees, success, label }, fee_series[]." },
  { id: "address-internal", method: "GET", path: "/api/v1/address/:addr/internal", title: "Internal transfers", category: "Addresses", tags: ["address", "internal transactions", "trace"],
    parameters: [{ name: "addr", location: "path", pattern: /^0x[0-9a-fA-F]{40}$/, description: "0x-prefixed 20-byte address." }, { name: "before", location: "query", min: 1, max: Number.MAX_SAFE_INTEGER, description: "Only rows below this block number (pagination)." }],
    description: "Value-moving internal calls to or from the address, from traced (sampled) blocks.",
    response: "Object: trace_every, internal[] { tx_hash, block_number, depth, call_type, from, to, value, error }, labels." },
  { id: "address-gas", method: "GET", path: "/api/v1/address/:addr/gas", title: "Address gas overpayment", category: "Addresses", tags: ["address", "gas"],
    parameters: [{ name: "addr", location: "path", pattern: /^0x[0-9a-fA-F]{40}$/, description: "0x-prefixed 20-byte address." }],
    description: "Gas fees the address paid for and never used, over its replayed transactions.",
    response: "Object: trace_every, sampled { txs, unused_fee, fees, efficiency }, sent_in_window." },
  { id: "address-staking", method: "GET", path: "/api/v1/address/:addr/staking", title: "Delegator positions", category: "Staking", tags: ["address", "staking", "delegations"],
    parameters: [{ name: "addr", location: "path", pattern: /^0x[0-9a-fA-F]{40}$/, description: "0x-prefixed 20-byte address." }],
    description: "Live delegations from the staking precompile (getDelegations + getDelegator) with measured delegator APR, and the address's staking event history.",
    response: "Object: address, delegations[] { validatorId, stake, unclaimedRewards, deltaStake, deltaEpoch, validator_name, delegator_apr }, events[]." },
  { id: "staking", method: "GET", path: "/api/v1/staking", title: "Delegation flows", category: "Staking", tags: ["staking", "delegations"], overview: true,
    parameters: [{ name: "hours", location: "query", default: "24", min: 1, max: 8760, description: "Trailing window in hours." }],
    description: "Stake delegated, undelegated, withdrawn and claimed over the window, per validator and in total, plus how far back staking history has been collected.",
    response: "Object: hours, totals { delegated, undelegated, withdrawn, claimed, net, addresses, events }, kinds[], flows[] { id, name, delegated, undelegated, net, claimed, delegators }, history { scanned_from_block, oldest_event, events }." },
  { id: "staking-rewards", method: "GET", path: "/api/v1/staking/rewards", title: "Measured reward rates", category: "Staking", tags: ["staking", "rewards", "apr"],
    parameters: [{ name: "hours", location: "query", default: "24", min: 1, max: 168, description: "Trailing window in hours." }],
    description: "Block rewards each validator's pool actually received (ValidatorRewarded events), annualised against the stake in force. delegator_apr is net of commission. Backward-looking and noisy for small validators.",
    response: "Object: hours, coverage, blocks, network_apr, total_rewards, validators[] { id, name, blocks, rewards, stake, commission, apr, delegator_apr }." },
  { id: "staking-events", method: "GET", path: "/api/v1/staking/events", title: "Staking events", category: "Staking", tags: ["staking", "events", "pagination"],
    parameters: [{ name: "limit", location: "query", default: "50", min: 1, max: 100, description: "Rows returned (1–100)." }, { name: "kind", location: "query", choices: ["delegate", "undelegate", "withdraw", "claim", "commission", "created", "status"], description: "Only this event kind." }, { name: "validator", location: "query", min: 0, max: Number.MAX_SAFE_INTEGER, description: "Only events for this validator id." }, { name: "before", location: "query", pattern: /^\d+:\d+$/, description: "Cursor \"block:log_index\" of the previous page's last row." }],
    description: "Staking precompile events, newest first: delegations, undelegations, withdrawals, reward claims, commission changes, validator creation and status changes.",
    response: "Object: events[] { tx_hash, block_number, time, kind, validator_id, validator_name, address, amount (wei), epoch, withdraw_id, old_commission, new_commission }." },
  { id: "pipeline", method: "GET", path: "/api/v1/pipeline", title: "MonadBFT pipeline", category: "Consensus", tags: ["consensus", "finality", "latency"], overview: true,
    parameters: [{ name: "minutes", location: "query", default: "10", min: 1, max: 1440, description: "Latency window in minutes." }],
    description: "Per-proposal commit stages (Proposed → Voted → Finalized → Verified) observed over monadNewHeads: p50/p95 stage latencies, stage heads and execution lag, recent blocks, and abandoned proposals (never finalized while a competing proposal at the same height did).",
    response: "Object: minutes, latency_ms { blocks, vote, finalize, total, verify }, heads { proposed, voted, finalized, verified, execution_lag }, abandoned_24h, abandoned[], abandoned_by_proposer[], recent[]." },
  { id: "stream", method: "GET", path: "/api/v1/stream", title: "Live stage stream", category: "Consensus", tags: ["consensus", "sse", "live"], binary: true,
    description: "Server-sent events: an event named \"stages\" carries the proposals whose commit stage changed, as JSON arrays of pipeline rows. Use EventSource; it reconnects on its own.",
    response: "text/event-stream. event: stages, data: [{ block_id, number, proposer_name, proposed_at, voted_at, finalized_at, verified_at, ms_to_vote, ms_to_finalize, ms_to_verify }]." },
  { id: "market", method: "GET", path: "/api/v1/market", title: "MON market price", category: "Analytics", tags: ["market", "MON"],
    description: "MON/USD and its 24-hour change from CoinGecko, fetched by the server at most once a minute.",
    response: "Object: id, usd, usd_24h_change. 503 when market data is unavailable." },
  { id: "health", method: "GET", path: "/health", title: "Health check", category: "Service", tags: ["health", "service"],
    description: "Returns once the API can query its database.",
    response: "Object: { ok: true }. 502 when the database is unreachable." },
  { id: "version", method: "GET", path: "/api/v1/version", title: "Deployed web build", category: "Service", tags: ["service", "build"],
    description: "Name of the web bundle currently served, so long-lived tabs can offer a reload.",
    response: "Object: web (bundle path or null)." },
];
export function filterApiEndpoints(category: string, search: string): ApiEndpoint[] {
  const q = search.trim().toLowerCase();
  return API_ENDPOINTS.filter(e => (q ? `${e.method} ${e.path} ${e.title} ${e.description} ${e.response} ${e.tags.join(" ")}`.toLowerCase().includes(q) : category === "Overview" ? e.overview : e.category === category));
}
export function apiRequestPath(endpoint: ApiEndpoint, values: Record<string, string>): { path: string; error?: never } | { error: string; path?: never } {
  let path = endpoint.path;
  const query = new URLSearchParams();
  for (const p of endpoint.parameters ?? []) {
    const value = (values[p.name] ?? p.default ?? "").trim();
    if (!value && p.location === "query" && !p.required) continue;
    if (!value) return { error: `${p.name} is required.` };
    if (p.pattern && !p.pattern.test(value)) return { error: `${p.name}: ${p.description}` };
    if (p.choices && !p.choices.includes(value)) return { error: `${p.name} must be ${p.choices.join(", ")}.` };
    if (p.min !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < p.min || Number(value) > p.max!)) return { error: `${p.name} must be a whole number between ${p.min.toLocaleString("en-US")} and ${p.max!.toLocaleString("en-US")}.` };
    if (p.location === "path") path = path.replace(`:${p.name}`, encodeURIComponent(value)); else query.set(p.name, value);
  }
  const qs = query.toString();
  return { path: path + (qs ? `?${qs}` : "") };
}
export function apiCurl(origin: string, path: string): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return `curl --request GET \\\n  --url ${quote(origin + path)} \\\n  --header 'Accept: application/json'`;
}
/** Preview only: copying always uses the untouched response. */
export function apiPreview(body: string, maxLines = 7): string {
  const lines = body.split("\n");
  const preview = lines.slice(0, maxLines).map(line => line.length > 240 ? line.slice(0, 240) + "…" : line).join("\n");
  return preview + (lines.length > maxLines ? `\n… ${lines.length - maxLines} more lines` : "");
}
