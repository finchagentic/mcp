import { callConvex } from "./convex.js";
import { getLocalVaultConfig } from "./local-vault.js";

// MCP has no persistent "active project" UI state the way the webapp Sidebar
// switcher does - a caller (vault_save, agent_spawn) names the project it
// wants by string on each call instead. Resolution + auto-create both happen
// server-side (POST /projects/resolve, see convex/http.ts +
// convex/projects.ts's resolveOrCreateProjectForUser) so the match/dedup
// logic exists in exactly one place, shared with the webapp's own project
// picker.
//
// Local-vault mode (vaultBackend: "local") has no project concept at all -
// it's a flat, unauthenticated file store on the user's own machine with no
// server to resolve a name against. Callers should check
// isLocalVaultActive() first and skip resolution entirely rather than call
// this and get a confusing network-style failure.
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
