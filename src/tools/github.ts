import * as fs from "fs";
import * as path from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";

const GH_BASE = "https://api.github.com";

// Was hardcoded "finch-mcp/3.28.0" - stale the moment package.json's version
// moved on (already 4.4.0 locally as of this fix), unlike server.ts/cli.ts/
// index.ts which all read it from package.json at runtime per this repo's
// own stated policy (see CLAUDE.md's mcp-server note). __dirname here is
// dist/tools/ once built, so two levels up reaches the package root - one
// level deeper than server.ts's own copy of this pattern (dist/).
const PKG_VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `finch-mcp/${PKG_VERSION}`,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function gh(path: string): Promise<any> {
  const res = await fetch(`${GH_BASE}${path}`, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`GitHub ${res.status}: ${err.message ?? res.statusText}`);
  }
  return res.json();
}

function md(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return structuredContent
    ? { content: [{ type: "text" as const, text }], structuredContent }
    : { content: [{ type: "text" as const, text }] };
}

// ── Structured output builders (MCP outputSchema payloads in output-schemas.ts) ──
export function buildRepoList(username: string | undefined, repos: any[]): Record<string, unknown> {
  return {
    username: username ?? null,
    count: repos.length,
    repos: repos.map((r) => ({
      fullName: r.full_name,
      description: r.description ?? null,
      language: r.language ?? null,
      stars: r.stargazers_count ?? 0,
      forks: r.forks_count ?? 0,
      private: !!r.private,
      updatedAt: r.updated_at ?? null,
      url: r.html_url,
    })),
  };
}

export function buildPrList(owner: string, repo: string, state: string, prs: any[]): Record<string, unknown> {
  return {
    owner, repo, state,
    count: prs.length,
    prs: prs.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user?.login ?? null,
      draft: !!p.draft,
      head: p.head?.ref ?? null,
      base: p.base?.ref ?? null,
      additions: p.additions ?? null,
      deletions: p.deletions ?? null,
      url: p.html_url,
      updatedAt: p.updated_at ?? null,
    })),
  };
}

export function buildPrDetail(pr: any, files: any[], reviews: any[], comments: any[]): Record<string, unknown> {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: !!pr.draft,
    author: pr.user?.login ?? null,
    head: pr.head?.ref ?? null,
    base: pr.base?.ref ?? null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    url: pr.html_url,
    files: (files ?? []).slice(0, 50).map((f) => ({
      filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
    })),
    reviewCount: (reviews ?? []).length,
    commentCount: (comments ?? []).length,
  };
}

export function buildIssueList(owner: string, repo: string, state: string, issues: any[]): Record<string, unknown> {
  return {
    owner, repo, state,
    count: issues.length,
    issues: issues.map((i) => ({
      number: i.number,
      title: i.title,
      author: i.user?.login ?? null,
      labels: (i.labels ?? []).map((l: any) => l.name),
      comments: i.comments ?? 0,
      url: i.html_url,
      updatedAt: i.updated_at ?? null,
    })),
  };
}

export function buildIssueDetail(issue: any, comments: any[]): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login ?? null,
    labels: (issue.labels ?? []).map((l: any) => l.name),
    assignees: (issue.assignees ?? []).map((a: any) => a.login),
    commentCount: (comments ?? []).length,
    url: issue.html_url,
    createdAt: issue.created_at ?? null,
  };
}

export function buildCommitList(owner: string, repo: string, branch: string | undefined, path: string | undefined, commits: any[]): Record<string, unknown> {
  return {
    owner, repo,
    branch: branch ?? null,
    path: path ?? null,
    count: commits.length,
    commits: commits.map((c) => ({
      sha: c.sha,
      message: c.commit?.message?.split("\n")[0] ?? null,
      author: c.commit?.author?.name ?? c.author?.login ?? null,
      date: c.commit?.author?.date ?? null,
      url: c.html_url,
    })),
  };
}

export function buildCodeSearch(query: string, totalCount: number, items: any[]): Record<string, unknown> {
  return {
    query,
    totalCount: totalCount ?? items.length,
    count: items.length,
    results: items.map((it) => ({ path: it.path, repo: it.repository?.full_name ?? null, url: it.html_url })),
  };
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function langExt(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    cs: "csharp", cpp: "cpp", c: "c", sh: "bash", yaml: "yaml", yml: "yaml",
    json: "json", toml: "toml", md: "markdown", html: "html", css: "css", sql: "sql",
  };
  return map[ext] ?? ext;
}

export const GITHUB_TOOLS: Tool[] = [
  {
    name: "github_list_repos",
    description:
      "List GitHub repositories for a user or org. Leave username empty to list your own repos (requires GITHUB_TOKEN). " +
      "Returns name, description, language, stars, forks, last updated.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "GitHub username or org. Empty = your own repos (needs GITHUB_TOKEN)." },
        sort:     { type: "string", enum: ["updated", "created", "pushed", "full_name"], description: "Sort field (default: updated)" },
        per_page: { type: "number", description: "Max results (default 20, max 100)" },
      },
    },
  },
  {
    name: "github_list_prs",
    description: "List pull requests for a GitHub repository. Returns PR number, title, author, state, branch, additions/deletions.",
    inputSchema: {
      type: "object",
      properties: {
        owner:    { type: "string", description: "Repo owner (user or org)" },
        repo:     { type: "string", description: "Repository name" },
        state:    { type: "string", enum: ["open", "closed", "all"], description: "PR state (default: open)" },
        per_page: { type: "number", description: "Max results (default 15, max 100)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_get_pr",
    description:
      "Get full details of a pull request - title, body, diff summary, changed files, reviews, and comments. " +
      "Use to understand what a PR does before reviewing or merging.",
    inputSchema: {
      type: "object",
      properties: {
        owner:     { type: "string", description: "Repo owner" },
        repo:      { type: "string", description: "Repository name" },
        pr_number: { type: "number", description: "Pull request number" },
      },
      required: ["owner", "repo", "pr_number"],
    },
  },
  {
    name: "github_list_issues",
    description: "List issues for a GitHub repository. Returns issue number, title, author, labels, comment count.",
    inputSchema: {
      type: "object",
      properties: {
        owner:    { type: "string", description: "Repo owner" },
        repo:     { type: "string", description: "Repository name" },
        state:    { type: "string", enum: ["open", "closed", "all"], description: "Issue state (default: open)" },
        labels:   { type: "string", description: "Comma-separated label names to filter by" },
        per_page: { type: "number", description: "Max results (default 15, max 100)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_get_issue",
    description: "Get a GitHub issue with full body and all comments. Use to understand a bug or feature request in depth.",
    inputSchema: {
      type: "object",
      properties: {
        owner:        { type: "string", description: "Repo owner" },
        repo:         { type: "string", description: "Repository name" },
        issue_number: { type: "number", description: "Issue number" },
      },
      required: ["owner", "repo", "issue_number"],
    },
  },
  {
    name: "github_get_file",
    description: "Read a file from a GitHub repository. Returns decoded content (up to 10k chars). Use for reading code, configs, READMEs.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner" },
        repo:  { type: "string", description: "Repository name" },
        path:  { type: "string", description: "File path in the repo (e.g. src/index.ts, README.md)" },
        ref:   { type: "string", description: "Branch, tag, or commit SHA (default: main branch)" },
      },
      required: ["owner", "repo", "path"],
    },
  },
  {
    name: "github_get_commits",
    description: "Get recent commits for a repo, branch, or specific file. Returns SHA, message, author, date.",
    inputSchema: {
      type: "object",
      properties: {
        owner:    { type: "string", description: "Repo owner" },
        repo:     { type: "string", description: "Repository name" },
        branch:   { type: "string", description: "Branch name (default: repo default branch)" },
        path:     { type: "string", description: "Filter to commits touching a specific file path" },
        per_page: { type: "number", description: "Number of commits (default 15, max 100)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_search_code",
    description:
      "Search code on GitHub. Supports qualifiers: repo:owner/repo, language:typescript, path:src/, filename:package.json, etc. " +
      "Requires GITHUB_TOKEN for best results.",
    inputSchema: {
      type: "object",
      properties: {
        query:    { type: "string", description: "Search query with optional qualifiers (e.g. 'useState repo:facebook/react language:typescript')" },
        per_page: { type: "number", description: "Max results (default 10, max 30)" },
      },
      required: ["query"],
    },
  },
];

export async function handleGithubTool(name: string, args: unknown): Promise<ToolResult | null> {
  const a = (args ?? {}) as any;

  switch (name) {
    case "github_list_repos": {
      const sort     = a.sort ?? "updated";
      const per_page = Math.min(a.per_page ?? 20, 100);
      const ghPath   = a.username
        ? `/users/${encodeURIComponent(a.username)}/repos?sort=${sort}&per_page=${per_page}`
        : `/user/repos?type=owner&sort=${sort}&per_page=${per_page}`;
      const repos: any[] = await gh(ghPath);
      const who = a.username ?? "you";
      const header = `## GitHub Repos — ${who} (${repos.length})\n`;
      const rows = repos.map(r => {
        const vis = r.private ? "🔒" : "📂";
        const lang = r.language ? ` · ${r.language}` : "";
        const desc = r.description ? `\n   ${r.description.slice(0, 100)}` : "";
        return `${vis} **[${r.full_name}](${r.html_url})** ⭐${r.stargazers_count} 🍴${r.forks_count}${lang} · ${fmtDate(r.updated_at)}${desc}`;
      });
      return md([header, ...rows].join("\n"), buildRepoList(a.username, repos));
    }

    case "github_list_prs": {
      const { owner, repo, state = "open" } = a;
      const per_page = Math.min(a.per_page ?? 15, 100);
      const prs: any[] = await gh(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${per_page}`);
      if (!prs.length) return md(`No ${state} PRs in **${owner}/${repo}**.`, buildPrList(owner, repo, state, []));
      const header = `## PRs — ${owner}/${repo} (${state}, ${prs.length})\n`;
      const rows = prs.map(p => {
        const draft = p.draft ? " `draft`" : "";
        const changes = (p.additions != null)
          ? ` · \`+${p.additions}/-${p.deletions}\``
          : "";
        const body = p.body ? `\n   ${p.body.slice(0, 120).replace(/\n/g, " ")}…` : "";
        return `**#${p.number}** [${p.title}](${p.html_url})${draft}\n   @${p.user?.login} · \`${p.head?.ref}\` → \`${p.base?.ref}\`${changes} · ${fmtDate(p.updated_at)}${body}`;
      });
      return md([header, ...rows].join("\n\n"), buildPrList(owner, repo, state, prs));
    }

    case "github_get_pr": {
      const { owner, repo, pr_number } = a;
      const [pr, files, reviews, comments]: any[] = await Promise.all([
        gh(`/repos/${owner}/${repo}/pulls/${pr_number}`),
        gh(`/repos/${owner}/${repo}/pulls/${pr_number}/files?per_page=50`),
        gh(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`),
        gh(`/repos/${owner}/${repo}/issues/${pr_number}/comments`),
      ]);
      const stateEmoji = pr.state === "open" ? (pr.draft ? "🟡 Draft" : "🟢 Open") : "🟣 Merged";
      const lines: string[] = [
        `## PR #${pr.number} — ${pr.title}`,
        `${stateEmoji} · @${pr.user?.login} · \`${pr.head?.ref}\` → \`${pr.base?.ref}\` · ${fmtDate(pr.updated_at)}`,
        `\`+${pr.additions ?? 0}/-${pr.deletions ?? 0}\` across ${pr.changed_files ?? 0} files · [View on GitHub](${pr.html_url})`,
      ];
      if (pr.body) {
        lines.push("", "### Description", pr.body.slice(0, 1500));
      }
      if (files?.length) {
        lines.push("", "### Changed Files");
        for (const f of files.slice(0, 25)) {
          const s = f.status === "added" ? "+" : f.status === "removed" ? "-" : "~";
          lines.push(`\`${s}\` \`${f.filename}\` (+${f.additions}/-${f.deletions})`);
          if (f.patch) lines.push(`\`\`\`diff\n${f.patch.slice(0, 800)}\n\`\`\``);
        }
        if (files.length > 25) lines.push(`_…and ${files.length - 25} more files_`);
      }
      if (reviews?.length) {
        lines.push("", "### Reviews");
        for (const r of reviews) {
          if (!r.body && r.state === "COMMENTED") continue;
          lines.push(`**@${r.user?.login}** ${r.state} · ${fmtDate(r.submitted_at)}${r.body ? `\n> ${r.body.slice(0, 300)}` : ""}`);
        }
      }
      if (comments?.length) {
        lines.push("", "### Comments");
        for (const c of comments.slice(0, 8)) {
          lines.push(`**@${c.user?.login}** · ${fmtDate(c.created_at)}\n> ${c.body?.slice(0, 400)}`);
        }
      }
      return md(lines.join("\n"), buildPrDetail(pr, files, reviews, comments));
    }

    case "github_list_issues": {
      const { owner, repo, state = "open", labels } = a;
      const per_page = Math.min(a.per_page ?? 15, 100);
      let issuePath = `/repos/${owner}/${repo}/issues?state=${state}&per_page=${per_page}`;
      if (labels) issuePath += `&labels=${encodeURIComponent(labels)}`;
      const all: any[] = await gh(issuePath);
      const issues = all.filter((i: any) => !i.pull_request);
      if (!issues.length) return md(`No ${state} issues in **${owner}/${repo}**${labels ? ` with labels: ${labels}` : ""}.`, buildIssueList(owner, repo, state, []));
      const header = `## Issues — ${owner}/${repo} (${state}, ${issues.length})\n`;
      const rows = issues.map((i: any) => {
        const lbls = i.labels?.length ? ` · ${i.labels.map((l: any) => `\`${l.name}\``).join(" ")}` : "";
        const cmts = i.comments ? ` · 💬${i.comments}` : "";
        const body = i.body ? `\n   ${i.body.slice(0, 100).replace(/\n/g, " ")}…` : "";
        return `**#${i.number}** [${i.title}](${i.html_url})\n   @${i.user?.login}${lbls}${cmts} · ${fmtDate(i.updated_at)}${body}`;
      });
      return md([header, ...rows].join("\n\n"), buildIssueList(owner, repo, state, issues));
    }

    case "github_get_issue": {
      const { owner, repo, issue_number } = a;
      const [issue, comments]: any[] = await Promise.all([
        gh(`/repos/${owner}/${repo}/issues/${issue_number}`),
        gh(`/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=20`),
      ]);
      const lbls = issue.labels?.length ? issue.labels.map((l: any) => `\`${l.name}\``).join(" ") : "";
      const assignees = issue.assignees?.length ? `Assigned: @${issue.assignees.map((a: any) => a.login).join(", @")}` : "";
      const lines: string[] = [
        `## Issue #${issue.number} — ${issue.title}`,
        `${issue.state === "open" ? "🟢 Open" : "🔴 Closed"} · @${issue.user?.login} · ${fmtDate(issue.created_at)} · [View on GitHub](${issue.html_url})`,
      ];
      if (lbls) lines.push(lbls);
      if (assignees) lines.push(assignees);
      if (issue.body) lines.push("", issue.body.slice(0, 3000));
      if (comments?.length) {
        lines.push("", `---`, "", `### Comments (${comments.length})`);
        for (const c of comments) {
          lines.push(`**@${c.user?.login}** · ${fmtDate(c.created_at)}`);
          lines.push(c.body?.slice(0, 1000) ?? "");
          lines.push("");
        }
      }
      return md(lines.join("\n"), buildIssueDetail(issue, comments));
    }

    case "github_get_file": {
      const { owner, repo, path: filePath, ref } = a;
      let fileUrl = `/repos/${owner}/${repo}/contents/${filePath}`;
      if (ref) fileUrl += `?ref=${encodeURIComponent(ref)}`;
      const data: any = await gh(fileUrl);
      if (data.type !== "file") {
        return md(
          `Not a file — got type \`${data.type}\`. Specify a full file path, not a directory.`,
          { owner, repo, path: filePath, isFile: false },
        );
      }
      const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
      const truncated = content.length > 10000;
      const lang = langExt(filePath);
      const lines = [
        `## \`${data.path}\` — ${owner}/${repo}${ref ? ` @ ${ref}` : ""}`,
        `Size: ${(data.size / 1024).toFixed(1)}KB · SHA: \`${data.sha?.slice(0, 8)}\` · [View on GitHub](${data.html_url})`,
        "",
        `\`\`\`${lang}`,
        content.slice(0, 10000),
        "```",
      ];
      if (truncated) lines.push(`\n_File truncated at 10,000 chars (${(content.length / 1024).toFixed(1)}KB total)._`);
      return md(lines.join("\n"), {
        owner, repo, path: data.path, ref: ref ?? null, isFile: true,
        sizeBytes: data.size ?? null, sha: data.sha ?? null, url: data.html_url ?? null,
        language: lang, truncated, content: content.slice(0, 10000),
      });
    }

    case "github_get_commits": {
      const { owner, repo, branch, path: filePath } = a;
      const per_page = Math.min(a.per_page ?? 15, 100);
      let commitUrl = `/repos/${owner}/${repo}/commits?per_page=${per_page}`;
      if (branch) commitUrl += `&sha=${encodeURIComponent(branch)}`;
      if (filePath) commitUrl += `&path=${encodeURIComponent(filePath)}`;
      const commits: any[] = await gh(commitUrl);
      if (!commits.length) return md(`No commits found in **${owner}/${repo}**${branch ? ` @ ${branch}` : ""}${filePath ? ` for \`${filePath}\`` : ""}.`, buildCommitList(owner, repo, branch, filePath, []));
      const filter = filePath ? ` · \`${filePath}\`` : "";
      const header = `## Commits — ${owner}/${repo}${branch ? ` @ ${branch}` : ""}${filter} (${commits.length})\n`;
      const rows = commits.map(c => {
        const msg = c.commit?.message?.split("\n")[0].slice(0, 100) ?? "(no message)";
        const author = c.commit?.author?.name ?? c.author?.login ?? "unknown";
        const sha = c.sha?.slice(0, 7);
        return `\`${sha}\` **${msg}**\n   @${author} · ${fmtDate(c.commit?.author?.date)} · [↗](${c.html_url})`;
      });
      return md([header, ...rows].join("\n\n"), buildCommitList(owner, repo, branch, filePath, commits));
    }

    case "github_search_code": {
      // GitHub's code-search endpoint requires authentication. Without
      // GITHUB_TOKEN it returns 422 with a non-obvious message. Detect that
      // case upfront and give the user a concrete setup path instead of an
      // opaque error.
      if (!process.env.GITHUB_TOKEN) {
        return {
          content: [{
            type: "text" as const,
            text: [
              `❌ **github_search_code requires authentication**`,
              ``,
              `GitHub's code-search API does not work for anonymous callers - they return 422.`,
              `Other \`github_*\` tools work without a token (rate-limited to 60 req/hr).`,
              ``,
              `**Setup (one-time):**`,
              ``,
              `1. Create a personal access token: https://github.com/settings/tokens`,
              `2. Minimum scopes needed: \`public_repo\` (or \`repo\` for private)`,
              `3. Set the env var in your MCP client config:`,
              ``,
              `   \`\`\`json`,
              `   {`,
              `     "mcpServers": {`,
              `       "finch": {`,
              `         "command": "npx",`,
              `         "args": ["-y", "@finchagentic/mcp"],`,
              `         "env": { "GITHUB_TOKEN": "ghp_..." }`,
              `       }`,
              `     }`,
              `   }`,
              `   \`\`\``,
              ``,
              `4. Restart the MCP client.`,
              ``,
              `Authenticated rate limit: 5,000 req/hr (vs 60 unauthenticated for non-search endpoints).`,
            ].join("\n"),
          }],
          isError: true,
        };
      }
      const { query } = a;
      const per_page = Math.min(a.per_page ?? 10, 30);
      try {
        const data: any = await gh(`/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`);
        const items: any[] = data.items ?? [];
        const header = `## Code Search — \`${query}\`\n${data.total_count?.toLocaleString()} total results (showing ${items.length})\n`;
        const rows = items.map((item: any) =>
          `**[\`${item.path}\`](${item.html_url})** · ${item.repository?.full_name}`
        );
        return md([header, ...rows].join("\n"), buildCodeSearch(query, data.total_count, items));
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `github_search_code failed: ${e.message}\n\nIf this says "Unprocessable Entity" or 422, your GITHUB_TOKEN may lack required scopes - needs at least \`public_repo\`.`,
          }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
