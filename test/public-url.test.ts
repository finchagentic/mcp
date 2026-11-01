import { describe, it, expect, vi, afterEach } from "vitest";
import { isPrivateAddress, assertPublicUrl } from "../src/public-url.js";
import { fetchPublic } from "../src/tools/research.js";

describe("isPrivateAddress normalisation", () => {
  const priv = [
    "127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "172.16.0.1", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fe80::1", "fd00::1", "fc00::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:1",
    "64:ff9b::7f00:1", "64:ff9b::169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::1", "::127.0.0.1",
    "2130706433", "0x7f000001", "017700000001", "0x7f.1", "127.1", "0177.0.0.1", "[::ffff:7f00:1]",
  ];
  for (const ip of priv) it(`blocks ${ip}`, () => expect(isPrivateAddress(ip)).toBe(true));
  const pub = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808"];
  for (const ip of pub) it(`allows ${ip}`, () => expect(isPrivateAddress(ip)).toBe(false));
});

describe("assertPublicUrl with encoded hosts", () => {
  for (const u of ["http://2130706433/", "http://0x7f000001/", "http://[::ffff:7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://[64:ff9b::a9fe:a9fe]/latest/meta-data", "http://017700000001/", "http://localhost/", "http://127.1/", "ftp://example.com/"]) {
    it(`refuses ${u}`, async () => expect(await assertPublicUrl(u)).not.toBeNull());
  }
  it("accepts a public literal", async () => expect(await assertPublicUrl("http://8.8.8.8/")).toBeNull());
});

describe("fetchPublic redirect handling", () => {
  afterEach(() => vi.restoreAllMocks());
  it("re-checks every hop: a public URL redirecting to metadata is blocked and never fetched", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (u: any, init: any) => {
      calls.push(String(u));
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }) as any);
    await expect(fetchPublic("http://8.8.8.8/start")).rejects.toThrow(/blocked/);
    expect(calls).toEqual(["http://8.8.8.8/start"]);
  });
  it("follows safe redirects (relative too) and returns the final response", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (u: any) => {
      n++;
      if (String(u) === "http://8.8.8.8/a") return new Response(null, { status: 301, headers: { location: "/b" } });
      return new Response("ok", { status: 200 });
    }) as any);
    const r = await fetchPublic("http://8.8.8.8/a");
    expect(await r.text()).toBe("ok");
    expect(n).toBe(2);
  });
  it("caps redirect loops", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => new Response(null, { status: 302, headers: { location: "http://8.8.8.8/x" } })) as any);
    await expect(fetchPublic("http://8.8.8.8/x")).rejects.toThrow(/too many redirects/);
  });
});
