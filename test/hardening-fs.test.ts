import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { ethers } from "ethers";

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "USERPROFILE", "FINCH_WALLET_PASSPHRASE", "FINCH_CONVEX_URL", "FINCH_ALLOW_CUSTOM_BACKEND_BYOK"];
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "finch-hard-"));
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.FINCH_WALLET_PASSPHRASE;
  vi.resetModules();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(home, { recursive: true, force: true });
});
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("config", () => {
  it("writeConfig does not overwrite a corrupt config: backs it up and throws", async () => {
    const dir = path.join(home, ".finch"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    const { writeConfig, readConfig } = await import("../src/config.js");
    expect(() => writeConfig({ email: "a@b.c" })).toThrow(/corrupt/);
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe("{ not json");
    expect(fs.readdirSync(dir).some((f) => f.startsWith("config.json.corrupt-"))).toBe(true);
    expect(readConfig()).toEqual({});
  });
  it("writes 0600 file in 0700 dir and merges", async () => {
    const { writeConfig, readConfig } = await import("../src/config.js");
    writeConfig({ email: "a@b.c" }); writeConfig({ name: "n" });
    expect(readConfig()).toMatchObject({ email: "a@b.c", name: "n" });
    expect(mode(path.join(home, ".finch"))).toBe(0o700);
    expect(mode(path.join(home, ".finch", "config.json"))).toBe(0o600);
  });
});

describe("wallet passphrase -> scrypt key, decrypt-compat", () => {
  it("opens a legacy sha256(passphrase) keystore and re-encrypts with the raw passphrase", async () => {
    const dir = path.join(home, ".finch"); fs.mkdirSync(dir, { recursive: true });
    const pass = "correct horse battery staple";
    const legacyKey = crypto.createHash("sha256").update(pass).digest("hex").slice(0, 32);
    const w = ethers.Wallet.createRandom();
    fs.writeFileSync(path.join(dir, "wallet.json"), await w.encrypt(legacyKey), { mode: 0o644 });
    process.env.FINCH_WALLET_PASSPHRASE = pass;
    const mod = await import("../src/wallet.js");
    expect(mod.getWalletKey()).toBe("pass:" + pass);
    const loaded = await mod.getOrCreateWallet();
    expect(loaded.address).toBe(w.address);
    // migrated: now opens with the raw passphrase and no longer with the legacy hash
    const raw = fs.readFileSync(path.join(dir, "wallet.json"), "utf8");
    expect((await ethers.Wallet.fromEncryptedJson(raw, "pass:" + pass)).address).toBe(w.address);
    await expect(ethers.Wallet.fromEncryptedJson(raw, legacyKey)).rejects.toThrow();
    expect(mode(path.join(dir, "wallet.json"))).toBe(0o600);
    // a second process (fresh module) reads the new format
    vi.resetModules();
    const again = await (await import("../src/wallet.js")).getOrCreateWallet();
    expect(again.address).toBe(w.address);
  }, 120_000);
  it("wrong passphrase still refuses to replace the wallet", async () => {
    const dir = path.join(home, ".finch"); fs.mkdirSync(dir, { recursive: true });
    const w = ethers.Wallet.createRandom();
    fs.writeFileSync(path.join(dir, "wallet.json"), await w.encrypt("pass:right"));
    process.env.FINCH_WALLET_PASSPHRASE = "wrong";
    const mod = await import("../src/wallet.js");
    await expect(mod.getOrCreateWallet()).rejects.toThrow(/Could not decrypt/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "wallet.json"), "utf8")).address).toBe(w.address.slice(2).toLowerCase());
  }, 120_000);
  it("chmods an existing loose wallet dir/files", async () => {
    const dir = path.join(home, ".finch"); fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const w = ethers.Wallet.createRandom();
    process.env.FINCH_WALLET_PASSPHRASE = "p";
    fs.writeFileSync(path.join(dir, "wallet.json"), await w.encrypt("pass:p"), { mode: 0o644 });
    fs.writeFileSync(path.join(dir, "other.json"), "{}", { mode: 0o644 });
    await (await import("../src/wallet.js")).getOrCreateWallet();
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, "wallet.json"))).toBe(0o600);
    expect(mode(path.join(dir, "other.json"))).toBe(0o600);
  }, 120_000);
});

describe("BYOK only goes to the official backend", () => {
  it("official host ok; custom host blocked unless opted in", async () => {
    const m = await import("../src/convex.js");
    expect(m.isOfficialBackend("https://valuable-fish-533.convex.site")).toBe(true);
    expect(m.isOfficialBackend("https://valuable-fish-533.convex.site.evil.com")).toBe(false);
    expect(m.isOfficialBackend("http://valuable-fish-533.convex.site")).toBe(false);
    expect(m.byokAllowed("https://evil.example.com")).toBe(false);
    process.env.FINCH_ALLOW_CUSTOM_BACKEND_BYOK = "1";
    expect(m.byokAllowed("https://evil.example.com")).toBe(true);
  });
});

describe("cli-install merge", () => {
  it("keeps existing env block, writes atomically, leaves .bak and mode", async () => {
    const { installIntoConfig } = await import("../src/cli-install.js");
    const cfgPath = path.join(home, "claude.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ other: 1, mcpServers: { x: { command: "x" }, finch: { command: "old", env: { FINCH_ALLOW_SPEND: "1", FINCH_TOOLS: "all" }, extra: true } } }), { mode: 0o640 });
    const r = installIntoConfig({ name: "t", configPath: cfgPath, serversKey: "mcpServers", entryStyle: "standard" });
    expect(r).toBe("updated");
    const out = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(out.other).toBe(1);
    expect(out.mcpServers.x.command).toBe("x");
    expect(out.mcpServers.finch.env).toEqual({ FINCH_ALLOW_SPEND: "1", FINCH_TOOLS: "all" });
    expect(out.mcpServers.finch.extra).toBe(true);
    expect(out.mcpServers.finch.command).toBe("npx");
    expect(JSON.parse(fs.readFileSync(cfgPath + ".bak", "utf8")).mcpServers.finch.command).toBe("old");
    expect(mode(cfgPath)).toBe(0o640);
    expect(fs.readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("skips unparseable config without touching it", async () => {
    const { installIntoConfig } = await import("../src/cli-install.js");
    const cfgPath = path.join(home, "c.json");
    fs.writeFileSync(cfgPath, "// jsonc\n{}");
    expect(installIntoConfig({ name: "t", configPath: cfgPath, serversKey: "mcpServers", entryStyle: "standard" })).toBe("skipped");
    expect(fs.readFileSync(cfgPath, "utf8")).toBe("// jsonc\n{}");
  });
});

describe("local vault", () => {
  it("new entries use full sha256 dirs, old 16-hex dirs remain readable, files are 0600", async () => {
    const v = await import("../src/local-vault.js");
    const cfg = { dir: path.join(home, ".finch", "vault") };
    const r = v.localVaultSave(cfg, { type: "note", title: "hello", content: "world" });
    const idx = JSON.parse(fs.readFileSync(path.join(cfg.dir, "index.json"), "utf8"));
    expect(idx.entries[r.key].dir).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(cfg.dir)).toBe(0o700);
    expect(mode(path.join(cfg.dir, "index.json"))).toBe(0o600);
    // simulate a pre-upgrade entry
    const oldDir = crypto.createHash("sha1").update("note/old").digest("hex").slice(0, 16);
    fs.mkdirSync(path.join(cfg.dir, "data", oldDir), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(cfg.dir, "data", oldDir, "v1"), "legacy body", { mode: 0o644 });
    idx.entries["note/old"] = { ...idx.entries[r.key], key: "note/old", dir: oldDir, title: "old" };
    fs.writeFileSync(path.join(cfg.dir, "index.json"), JSON.stringify(idx));
    expect(v.localVaultRead(cfg, "note/old").content).toBe("legacy body");
    v.localVaultSave(cfg, { type: "note", title: "x", content: "y" }); // triggers hardening of the existing tree once per process
  });
  it("corrupt index is not treated as empty", async () => {
    const v = await import("../src/local-vault.js");
    const cfg = { dir: path.join(home, ".finch", "vault") };
    fs.mkdirSync(cfg.dir, { recursive: true });
    fs.writeFileSync(path.join(cfg.dir, "index.json"), "{broken");
    expect(() => v.localVaultSave(cfg, { type: "note", title: "a", content: "b" })).toThrow(/corrupt/);
    expect(fs.readFileSync(path.join(cfg.dir, "index.json"), "utf8")).toBe("{broken");
  });
  it("credentials round-trip and the store/key are 0600", async () => {
    const v = await import("../src/local-vault.js");
    const cfg = { dir: path.join(home, ".finch", "vault") };
    v.localVaultStoreCredential(cfg, "n", "secret-v");
    expect(v.localVaultGetCredential(cfg, "n").value).toBe("secret-v");
    expect(mode(path.join(cfg.dir, ".credkey"))).toBe(0o600);
    expect(mode(path.join(cfg.dir, "credentials.json"))).toBe(0o600);
  });
});

describe("cron line quoting", () => {
  it("source quotes the log path", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "cli-orders.ts"), "utf8");
    expect(src).toMatch(/>> \$\{shq\(logFile\)\}/);
  });
});
