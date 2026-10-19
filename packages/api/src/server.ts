/**
 * Monad Explorer — Fastify REST API + explorer host.
 * Serves the React app (packages/web/dist) at "/" and JSON at "/api/v1/*".
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { JsonRpc, createDb, loadEnv, rpcUrlsFromEnv } from "@monad-explorer/core";
import { registerRoutes } from "./routes.js";
import { registerNetworkRoutes } from "./network.js";
import { registerInsightRoutes } from "./insights.js";

loadEnv();

const PORT = Number(process.env.API_PORT ?? 3001);
/**
 * Loopback by default: the host has a public IP and no firewall, so the API
 * is only published through the Caddy facade (deploy/Caddyfile.monad).
 */
const HOST = process.env.API_HOST ?? "127.0.0.1";

const { pool } = createDb();
// The API's reads are interactive and bursty; it gets its own smaller budget
// so the indexer (separate process, separate bucket) keeps the larger share
// of the gateway's ~50 req/s per-IP limit.
const rpc = new JsonRpc(rpcUrlsFromEnv(), Number(process.env.API_RPC_RPS ?? 15));
const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(here, "..", "..", "web", "dist");

/**
 * Security headers and cache policy. API responses are no-store (an explorer
 * showing a stale head is wrong); the SPA gets the standard anti-embedding set.
 */
fastify.addHook("onSend", async (req, reply, payload) => {
  if (req.url.startsWith("/api/") || req.url === "/health") {
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  }
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "strict-origin-when-cross-origin");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:",
  );
  return payload;
});

fastify.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  req.log.error({ err }, "request failed");
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 502;
  reply.code(status).send({ error: status === 502 ? "upstream RPC or database unavailable" : err.message });
});

registerRoutes(fastify, { pool, rpc });
const insights = registerInsightRoutes(fastify, { pool, rpc });
registerNetworkRoutes(fastify, { pool, rpc, rewardRates: () => insights.rewardRates("24") });

/** Which web bundle is deployed, so long-lived tabs can offer a reload. */
const deployedWeb = (() => {
  try {
    const html = readFileSync(path.join(webDist, "index.html"), "utf8");
    return html.match(/assets\/index-[^"]+\.js/)?.[0] ?? null;
  } catch {
    return null;
  }
})();
fastify.get("/api/v1/version", async () => ({ web: deployedWeb }));

if (existsSync(webDist)) {
  await fastify.register(fastifyStatic, { root: webDist, prefix: "/" });
  fastify.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && req.url !== "/health") {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "not found" });
  });
} else {
  fastify.get("/", async () => ({
    status: "explorer not built yet",
    hint: "run: pnpm --filter @monad-explorer/web build",
  }));
}

const shutdown = async (sig: string) => {
  fastify.log.info({ sig }, "shutting down");
  try {
    await fastify.close();
  } finally {
    await pool.end();
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

fastify
  .listen({ port: PORT, host: HOST })
  .then(() => fastify.log.info(`monad explorer API on http://${HOST}:${PORT}`))
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
