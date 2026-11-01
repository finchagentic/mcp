// Private-by-default filesystem helpers. Everything under ~/.finch holds secrets
// (wallet keystores, API keys, vault credentials, order books, spend ledger), so
// directories are 0700, files are 0600, and writes are atomic (tmp + rename) so a
// crash can never leave a half-written keystore behind.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** ~/.finch, resolved lazily so tests (and HOME changes) are respected. */
export function finchDir(): string {
  return path.join(os.homedir(), ".finch");
}

/** mkdir -p with 0700, and tighten an existing directory's mode. Best effort on chmod (Windows / foreign owner). */
export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try { fs.chmodSync(dir, PRIVATE_DIR_MODE); } catch { /* best effort */ }
  return dir;
}

/** chmod an existing file to 0600. Returns true if the file existed. Never throws. */
export function chmodPrivate(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    fs.chmodSync(file, PRIVATE_FILE_MODE);
    return true;
  } catch { return false; }
}

/** Atomic write: tmp file (0600, exclusive) in the same dir, fsync, rename over the target. */
export function writePrivateFile(file: string, data: string | Buffer, opts: { backup?: boolean } = {}): void {
  ensurePrivateDir(path.dirname(file));
  if (opts.backup && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
      chmodPrivate(`${file}.bak`);
    } catch { /* backup is best effort */ }
  }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", PRIVATE_FILE_MODE);
  try {
    fs.writeFileSync(fd, data);
    try { fs.fsyncSync(fd); } catch { /* not all FS support it */ }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  chmodPrivate(file);
}

export function writePrivateJson(file: string, value: unknown, opts: { backup?: boolean } = {}): void {
  writePrivateFile(file, JSON.stringify(value, null, 2), opts);
}

/** Read + parse JSON. Returns `fallback` ONLY when the file is absent; a corrupt file throws so callers never overwrite it. */
export function readJsonStrict<T>(file: string, fallback: T): T {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e: any) { if (e?.code === "ENOENT") return fallback; throw e; }
  if (!raw.trim()) return fallback;
  return JSON.parse(raw) as T;
}

/** Tighten permissions of every regular file directly inside `dir` (and the dir itself). */
export function hardenDir(dir: string): number {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  try { fs.chmodSync(dir, PRIVATE_DIR_MODE); } catch { /* ignore */ }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) n += hardenDir(p);
    else if (ent.isFile() && chmodPrivate(p)) n++;
  }
  return n;
}
