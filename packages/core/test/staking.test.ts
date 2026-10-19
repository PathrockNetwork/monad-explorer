import { describe, expect, it } from "vitest";
import { parseRegistryEntry } from "../src/staking";

const secp = "02" + "ab".repeat(32);
const base = {
  id: 42,
  name: "PathrockNetwork",
  secp,
  website: "https://pathrocknetwork.org/",
  description: "Open infrastructure",
  logo: "https://example.com/logo.png",
  x: "https://x.com/pathrock",
  vdp: true,
  decommissioned: false,
};

describe("parseRegistryEntry", () => {
  it("accepts an entry that matches the chain's id and key", () => {
    expect(parseRegistryEntry(base, { id: 42, secp })).toMatchObject({ name: "PathrockNetwork", logo: "https://example.com/logo.png", vdp: true });
  });

  it("rejects an entry claiming another validator's id or key", () => {
    expect(parseRegistryEntry({ ...base, id: 7 }, { id: 42, secp })).toBeNull();
    expect(parseRegistryEntry({ ...base, secp: "03" + "cd".repeat(32) }, { id: 42, secp })).toBeNull();
  });

  it("drops non-https links and strips control characters", () => {
    const e = parseRegistryEntry(
      { ...base, logo: "javascript:alert(1)", website: "http://insecure.example", name: "Evil\u0000\u001bName" },
      { id: 42, secp },
    );
    expect(e?.logo).toBeNull();
    expect(e?.website).toBeNull();
    expect(e?.name).toBe("EvilName");
  });

  it("caps oversized text", () => {
    expect(parseRegistryEntry({ ...base, name: "x".repeat(500) }, { id: 42, secp })?.name).toHaveLength(64);
  });
});
