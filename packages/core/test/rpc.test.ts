import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpc } from "../src/rpc";

type Handler = (url: string, body: any[]) => { status?: number; json: unknown };

function stubFetch(handler: Handler) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    seen.push(`${new URL(url).host}:${body.map((c: any) => c.method).join(",")}`);
    const r = handler(url, body);
    return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, json: async () => r.json } as Response;
  });
  return seen;
}

const ok = (body: any[], result: unknown) => body.map((c) => ({ jsonrpc: "2.0", id: c.id, result }));

afterEach(() => vi.unstubAllGlobals());

describe("JsonRpc capability failover", () => {
  it("routes a method an endpoint refuses to the next one, and remembers", async () => {
    const seen = stubFetch((url, body) =>
      url.includes("a.test") && body.some((c) => c.method.startsWith("debug_"))
        ? { json: body.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32053, message: "API key is not allowed to access method" } })) }
        : { json: ok(body, "0x1") },
    );
    const rpc = new JsonRpc(["https://a.test", "https://b.test"], 1000);
    expect(await rpc.call("debug_traceBlockByNumber", ["0x1"])).toBe("0x1");
    expect(await rpc.call("debug_traceBlockByNumber", ["0x2"])).toBe("0x1");
    // Other methods still prefer the first endpoint.
    expect(await rpc.call("eth_chainId")).toBe("0x1");
    expect(seen).toEqual([
      "a.test:debug_traceBlockByNumber",
      "b.test:debug_traceBlockByNumber",
      "b.test:debug_traceBlockByNumber",
      "a.test:eth_chainId",
    ]);
  });

  it("learns a smaller batch limit from HTTP 413", async () => {
    const seen = stubFetch((url, body) => (url.includes("a.test") && body.length > 2 ? { status: 413, json: {} } : { json: ok(body, "0x2") }));
    const rpc = new JsonRpc(["https://a.test", "https://b.test"], 1000);
    const calls = Array.from({ length: 3 }, () => ({ method: "eth_chainId", params: [] }));
    expect(await rpc.batch(calls)).toEqual(["0x2", "0x2", "0x2"]);
    expect(await rpc.batch(calls)).toEqual(["0x2", "0x2", "0x2"]);
    expect(seen[0]!.startsWith("a.test")).toBe(true);
    expect(seen.slice(1).every((s) => s.startsWith("b.test"))).toBe(true);
  });

  it("still surfaces a genuine call error without failing over", async () => {
    stubFetch((_url, body) => ({ json: body.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: 3, message: "execution reverted" } })) }));
    const rpc = new JsonRpc(["https://a.test", "https://b.test"], 1000);
    await expect(rpc.call("eth_call", [{}])).rejects.toThrow("execution reverted");
  });
});
