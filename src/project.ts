import { callConvex } from "./convex.js";
import { getLocalVaultConfig } from "./local-vault.js";

// No persistent "active project" state here - callers name the project by
// string each call; resolution/auto-create happens server-side (POST
// /projects/resolve), shared with the webapp's own picker. Local-vault mode
// has no project concept at all - check isLocalVaultActive() first.
export function isLocalVaultActive(): boolean {
  return !!getLocalVaultConfig();
}

export async function resolveProjectId(name: string): Promise<{ projectId: string; slug: string; name: string; created: boolean } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  try {
    return await callConvex("/projects/resolve", "POST", { name: trimmed }, "vault_save") as {
      projectId: string; slug: string; name: string; created: boolean;
    };
  } catch {
    // Resolution is best-effort - a save should never fail just because the
    // project lookup did. Falls back to unassigned, same as the webapp's
    // agent_spawn membership check when a stale/bad id doesn't match.
    return null;
  }
}
