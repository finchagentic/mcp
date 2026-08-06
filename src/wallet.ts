import { ethers } from "ethers";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

// Read RPC - balance, gas, nonce lookups. Speed > privacy for reads.
// Override with FINCH_RPC_URL if you want a single custom endpoint.
export const BASE_RPC = process.env.FINCH_RPC_URL
  ?? (ALCHEMY_API_KEY
    ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
    : "https://mainnet.base.org");

// Broadcast RPC - used for eth_sendRawTransaction only. Set to an MEV-protect
// endpoint (e.g. Merkle.io, Blink, Coinbase Sequencer's private endpoint) to
// route signed transactions through a private relay instead of the public
// mempool. Defaults to BASE_RPC if not set.
//
// Note: Base's sequencer is already centralized (Coinbase) and does not expose
// a public mempool the way Ethereum L1 does - MEV exposure is materially
// lower than mainnet. This setting is for users who want belt-and-suspenders.
export const BROADCAST_RPC = process.env.FINCH_BROADCAST_RPC ?? BASE_RPC;
export const MEV_PROTECT_ENABLED = !!process.env.FINCH_BROADCAST_RPC;

export const BASE_CHAIN_ID = 8453;

const WALLET_DIR = path.join(os.homedir(), ".finch");
const WALLET_FILE = path.join(WALLET_DIR, "wallet.json");
// Per-install random secret folded into the no-passphrase key derivation
// (see getMachineKey). Generated once via crypto.randomBytes and stored
// 0600 next to the wallet - real entropy, unlike hostname/platform/arch
// which are guessable/public and give an attacker who copies the wallet
// file everything they need to also derive the key.
const LOCAL_SECRET_FILE = path.join(WALLET_DIR, ".local-secret");
let _cachedWallet: ethers.Wallet | ethers.HDNodeWallet | null = null;

export function clearWalletCache(): void { _cachedWallet = null; }

function getOrCreateLocalSecret(): string {
  try {
    const existing = fs.readFileSync(LOCAL_SECRET_FILE, "utf8").trim();
    if (existing) return existing;
  } catch { /* doesn't exist yet, or unreadable - (re)create below */ }
  const secret = crypto.randomBytes(32).toString("hex");
  if (!fs.existsSync(WALLET_DIR)) fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

export function getMachineKey(): string {
  // A passphrase is meant to make the wallet portable (move the encrypted
  // file + set the same passphrase elsewhere and it still decrypts) - so when
  // one is set, derive the key from ONLY the passphrase, no machine binding.
  const passphrase = process.env.FINCH_WALLET_PASSPHRASE ?? "";
  if (passphrase) {
    return crypto.createHash("sha256").update(passphrase).digest("hex").slice(0, 32);
  }
  // Without a passphrase, this is convenience-only encryption - it still
  // can't stop an attacker who obtains BOTH files (the encrypted wallet and
  // this local secret), the same as any locally-stored key material. What it
  // does stop is the weaker, more common case this used to be vulnerable to:
  // hostname/platform/arch alone are public/guessable, so a copy of just the
  // wallet file (backup sync, stolen disk, malware scraping known paths) used
  // to be enough to brute-force the key offline. Folding in a random,
  // file-local secret means the wallet file alone is no longer sufficient.
  return crypto
    .createHash("sha256")
    .update(getOrCreateLocalSecret() + os.hostname() + os.platform() + os.arch())
    .digest("hex")
    .slice(0, 32);
}

/** Pre-entropy-fix no-passphrase key: machine info only, no local secret.
 *  Kept solely so wallets encrypted before this fix still open; migrated to
 *  the new scheme in place on first successful decrypt, same pattern as
 *  getLegacyMachineKey below. */
function getLegacyMachineOnlyKey(): string {
  return crypto
    .createHash("sha256")
    .update(os.hostname() + os.platform() + os.arch())
    .digest("hex")
    .slice(0, 32);
}

/**
 * Pre-fix key derivation: always folded in machine info even when a
 * passphrase was set, so a wallet encrypted before this fix can only ever be
 * decrypted on the exact machine that created it - never portable. Kept
 * solely so those existing wallets still open; getOrCreateWallet migrates
 * them to the portable scheme in place on first successful decrypt.
 *
 * `passphrase` is a parameter, not read from env, because the whole point of
 * this fallback is testing what the file was ACTUALLY encrypted with - which
 * may not be today's FINCH_WALLET_PASSPHRASE. The most common case this
 * exists for: a user who never set a passphrase before (so the file was
 * encrypted with "" + machine info) setting one for the FIRST time just now -
 * at that moment env has the new passphrase, but the file predates it.
 */
function getLegacyMachineKey(passphrase: string): string {
  return crypto
    .createHash("sha256")
    .update(passphrase + os.hostname() + os.platform() + os.arch())
    .digest("hex")
    .slice(0, 32);
}

let _passphraseWarned = false;
export function warnIfNoPassphrase(): void {
  if (_passphraseWarned || process.env.FINCH_WALLET_PASSPHRASE) return;
  _passphraseWarned = true;
  // stderr only - stdout is reserved for MCP JSON-RPC framing when running as a server.
  process.stderr.write(
    "\n⚠️  FINCH_WALLET_PASSPHRASE is not set. Your local wallet " +
    `(${WALLET_FILE}, used on both Base and Robinhood Chain) is encrypted with a key derived from a random ` +
    `per-install secret (${LOCAL_SECRET_FILE}) plus this machine's hostname/platform/arch. That stops the wallet ` +
    "file alone from being crackable, but anyone who copies BOTH files together (backup sync, stolen disk, " +
    "malware) still gets the wallet. Set FINCH_WALLET_PASSPHRASE to a strong secret you keep out of that backup " +
    "for real protection. This wallet holds real funds.\n\n"
  );
}

let _walletCreationPromise: Promise<ethers.Wallet | ethers.HDNodeWallet> | null = null;

export async function getOrCreateWallet(): Promise<ethers.Wallet | ethers.HDNodeWallet> {
  if (_cachedWallet) return _cachedWallet;
  // In-process mutex: two concurrent first-run callers (before _cachedWallet
  // is set) must not each independently generate + write their own random
  // wallet - only one write can ever survive on disk, and the loser would go
  // on signing in-memory with a keypair that no longer matches what's
  // persisted, silently switching the user's wallet identity mid-session.
  // Chain all concurrent first-run callers through one shared promise.
  if (_walletCreationPromise) return _walletCreationPromise;
  _walletCreationPromise = loadOrCreateWallet();
  try {
    return await _walletCreationPromise;
  } finally {
    _walletCreationPromise = null;
  }
}

async function loadOrCreateWallet(): Promise<ethers.Wallet | ethers.HDNodeWallet> {
  if (_cachedWallet) return _cachedWallet;
  warnIfNoPassphrase();
  if (fs.existsSync(WALLET_FILE)) {
    const encrypted = fs.readFileSync(WALLET_FILE, "utf8");
    try {
      const wallet = await ethers.Wallet.fromEncryptedJson(encrypted, getMachineKey());
      _cachedWallet = wallet;
      return wallet;
    } catch (currentErr: any) {
      // Fall back to the pre-fix machine-bound scheme, for wallets encrypted
      // before passphrases became portable. Only relevant on the ORIGINAL
      // machine (it still needs that machine's hostname/platform/arch) - it
      // can't rescue a wallet file copied to a new machine from before this
      // fix; there was no passphrase-only secret saved anywhere to recover.
      //
      // Try two legacy candidates: today's passphrase (in case it was already
      // set when this file was encrypted) and "" (the common case - a user
      // setting FINCH_WALLET_PASSPHRASE for the first time, whose existing
      // file predates having any passphrase at all).
      const legacyCandidates = [...new Set([process.env.FINCH_WALLET_PASSPHRASE ?? "", ""])];
      let legacyWallet: ethers.Wallet | ethers.HDNodeWallet | null = null;
      for (const candidate of legacyCandidates) {
        try {
          legacyWallet = await ethers.Wallet.fromEncryptedJson(encrypted, getLegacyMachineKey(candidate));
          break;
        } catch { /* try next candidate */ }
      }
      if (legacyWallet) {
        _cachedWallet = legacyWallet;
        // Migrate in place to the portable scheme now that we've proven we
        // hold the right key, so this only ever needs to happen once.
        try {
          const migrated = await legacyWallet.encrypt(getMachineKey());
          fs.writeFileSync(WALLET_FILE, migrated, { mode: 0o600 });
          process.stderr.write(`\nMigrated ${WALLET_FILE} to the portable passphrase scheme.\n\n`);
        } catch {
          /* migration is best-effort - the legacy key still works next run either way */
        }
        return legacyWallet;
      }
      // Third tier: no passphrase ever set, and this wallet predates the fix
      // that folds a random local secret into the no-passphrase key (it was
      // encrypted with hostname/platform/arch alone). Try that exact old
      // derivation before giving up.
      if (!process.env.FINCH_WALLET_PASSPHRASE) {
        try {
          const oldNoPassWallet = await ethers.Wallet.fromEncryptedJson(encrypted, getLegacyMachineOnlyKey());
          _cachedWallet = oldNoPassWallet;
          try {
            const migrated = await oldNoPassWallet.encrypt(getMachineKey());
            fs.writeFileSync(WALLET_FILE, migrated, { mode: 0o600 });
            process.stderr.write(`\nMigrated ${WALLET_FILE} to the higher-entropy no-passphrase scheme.\n\n`);
          } catch {
            /* migration is best-effort - the legacy key still works next run either way */
          }
          return oldNoPassWallet;
        } catch { /* not this scheme either - fall through to the hard failure below */ }
      }
      {
        // A wallet file already exists but couldn't be decrypted under either
        // scheme - this almost always means FINCH_WALLET_PASSPHRASE doesn't
        // match what encrypted it, or this is a different machine and no
        // passphrase was ever set. Silently creating a fresh wallet here
        // would overwrite the existing encrypted file, orphaning it and any
        // funds it controls. Refuse instead.
        throw new Error(
          `Could not decrypt existing wallet at ${WALLET_FILE}: ${currentErr?.message ?? "unknown error"}\n\n` +
          `This usually means FINCH_WALLET_PASSPHRASE doesn't match the passphrase ` +
          `used when this wallet was encrypted, or this file was copied from a ` +
          `different machine and no passphrase was set when it was created (in ` +
          `which case the key was machine-bound and cannot be recovered elsewhere). ` +
          `Refusing to auto-create a replacement wallet, since that would silently ` +
          `orphan the existing one and any funds it holds.\n\n` +
          `If you're sure this wallet should be abandoned, move or delete ${WALLET_FILE} manually first.`
        );
      }
    }
  }
  const wallet = ethers.Wallet.createRandom();
  if (!fs.existsSync(WALLET_DIR)) fs.mkdirSync(WALLET_DIR, { recursive: true });
  const encrypted = await wallet.encrypt(getMachineKey());
  try {
    // Exclusive create ("wx") - guards the cross-process version of the race
    // the in-process mutex above already closes: two separate `finch`
    // invocations racing on the very first run, before this file exists.
    fs.writeFileSync(WALLET_FILE, encrypted, { mode: 0o600, flag: "wx" });
    _cachedWallet = wallet;
    return wallet;
  } catch (writeErr: any) {
    if (writeErr?.code !== "EEXIST") throw writeErr;
    // Another process won the race and created the file first. Use theirs -
    // never sign with the wallet we generated in memory once it's clear it
    // isn't the one actually persisted to disk.
    const encryptedExisting = fs.readFileSync(WALLET_FILE, "utf8");
    const existingWallet = await ethers.Wallet.fromEncryptedJson(encryptedExisting, getMachineKey());
    _cachedWallet = existingWallet;
    return existingWallet;
  }
}

export async function signRequest(toolName: string): Promise<{ address: string; signature: string; timestamp: string }> {
  const wallet = await getOrCreateWallet();
  const timestamp = Date.now().toString();
  const signature = await wallet.signMessage(`finch:${toolName}:${timestamp}`);
  return { address: wallet.address, signature, timestamp };
}

async function rpcPost(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(`RPC ${method} failed: ${data.error.message}`);
  return data.result;
}

async function getNonce(address: string): Promise<number> {
  return parseInt(await rpcPost("eth_getTransactionCount", [address, "latest"]), 16);
}

async function getGasPrice(): Promise<bigint> {
  return BigInt(await rpcPost("eth_gasPrice", []));
}

async function broadcastTx(signedTx: string): Promise<string> {
  // Route eth_sendRawTransaction through BROADCAST_RPC (may be MEV-protected)
  // while reads stay on the fast BASE_RPC.
  const res = await fetch(BROADCAST_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signedTx] }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(`broadcast failed: ${data.error.message}`);
  return data.result;
}

/**
 * Poll for the mined receipt and report the ACTUAL on-chain outcome.
 *
 * eth_sendRawTransaction only confirms the mempool accepted the tx, not that
 * it succeeded - a stale quote, slippage beyond the router's own guard, or an
 * allowance edge case can all revert on-chain while still broadcasting fine.
 * Callers must gate their success/failure message on this, not on
 * signAndBroadcast() returning a hash.
 */
export async function waitForReceipt(
  txHash: string,
  timeoutMs = 60_000,
  pollMs = 2_000
): Promise<{ mined: boolean; ok?: boolean; blockNumber?: number; gasUsed?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await rpcPost("eth_getTransactionReceipt", [txHash]);
      if (receipt) {
        return {
          mined: true,
          ok: parseInt(receipt.status, 16) === 1,
          blockNumber: parseInt(receipt.blockNumber, 16),
          gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed).toString() : undefined,
        };
      }
    } catch {
      /* transient RPC error - keep polling until timeout */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { mined: false };
}

export async function signAndBroadcast(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  txData: {
    to: string;
    data: string;
    value: string;
    gas?: string;
    gasPrice?: string;
    permit2?: any;
    issues?: any;
  }
): Promise<string> {
  let data = txData.data || "0x";
  if (txData.permit2?.eip712) {
    const eip712 = txData.permit2.eip712;
    const { EIP712Domain: _d, ...typesWithout } = eip712.types ?? {};
    const sig = await wallet.signTypedData(eip712.domain, typesWithout, eip712.message);
    data = data + sig.replace("0x", "");
  }

  const [nonce, gasPrice] = await Promise.all([getNonce(wallet.address), getGasPrice()]);

  const tx = {
    to: txData.to,
    data,
    value: BigInt(txData.value || "0"),
    gasLimit: BigInt(txData.gas || "200000"),
    gasPrice: txData.gasPrice ? BigInt(txData.gasPrice) : gasPrice,
    nonce,
    chainId: BASE_CHAIN_ID,
  };

  const signedTx = await wallet.signTransaction(tx);
  return broadcastTx(signedTx);
}
