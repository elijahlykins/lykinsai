/**
 * GitHub tools — a SERVICE/TOOL integration, not a RemoteExecutor transport.
 *
 * GitHub is the collaboration API surface (issues, PRs, checks, comments). It
 * COMPOSES with execution rather than being an execution environment: a Task
 * reads an issue with a GitHub tool, edits/tests with LocalExecutor or
 * RemoteExecutor, then opens a PR with a GitHub tool — all one canonical Task.
 * Git transport (status/diff/commit/push) stays with Local/Remote executors;
 * only the service API lives here.
 *
 * Design constraints honored:
 *   - No new SDK. Plain REST over injectable fetch (the repo has no Octokit,
 *     and every other provider call here uses fetch).
 *   - Credentials are a REFERENCE. The caller injects `resolveToken(authRef)`,
 *     which returns the token inside trusted host code. The token NEVER appears
 *     in a tool result, an error string, a log, or a model prompt.
 *   - Read/write capability split is enforced in code: a read-only Task can
 *     read repos/issues/PRs/checks but can never comment, branch, open, or
 *     merge — regardless of what the model asks for.
 *   - External writes are approval-gated by default. Reading is autonomous;
 *     publishing/commenting/merging is a human decision.
 *   - Remote/GitHub text (issue bodies, PR comments, file contents) is
 *     UNTRUSTED data. It is returned labeled so a downstream reasoner treats it
 *     as information, never as authority to expand scope.
 */

const GITHUB_API_BASE = "https://api.github.com";

/**
 * Capability grammar for GitHub, deliberately narrow:
 *   github.read       — all read tools
 *   github.write      — create branch, create issue, comment (external writes)
 *   github.pr.create  — open a pull request (external publication)
 *   github.pr.merge   — merge a pull request (consequential)
 * The blanket "github" grants read only — writes must be granted explicitly, so
 * "connected" never implies "may publish".
 */
const GITHUB_TOOLS = Object.freeze({
  github_get_repo: { capability: "github.read", write: false },
  github_get_issue: { capability: "github.read", write: false },
  github_list_issues: { capability: "github.read", write: false },
  github_get_pull_request: { capability: "github.read", write: false },
  github_list_pull_requests: { capability: "github.read", write: false },
  github_get_checks: { capability: "github.read", write: false },
  github_get_file: { capability: "github.read", write: false },
  github_search: { capability: "github.read", write: false },
  github_create_branch: { capability: "github.write", write: true },
  github_create_issue: { capability: "github.write", write: true },
  github_comment: { capability: "github.write", write: true },
  github_create_pull_request: { capability: "github.pr.create", write: true },
  github_merge_pull_request: { capability: "github.pr.merge", write: true },
});

const GITHUB_READ = "github.read";
const GITHUB_BLANKET = "github";

function capSet(capabilities) {
  return new Set((Array.isArray(capabilities) ? capabilities : []).map(String).filter(Boolean));
}

/** Does a capability set license this tool? Enforced before any network call. */
function githubToolAllowed(tool, capabilities) {
  const meta = GITHUB_TOOLS[tool];
  if (!meta) return false;
  const caps = capSet(capabilities);
  if (!meta.write) {
    // Reads: the blanket "github" grant or explicit github.read (or any write
    // capability, which implies read).
    return (
      caps.has(GITHUB_BLANKET) ||
      caps.has(GITHUB_READ) ||
      caps.has("github.write") ||
      caps.has("github.pr.create") ||
      caps.has("github.pr.merge")
    );
  }
  // Writes require the exact capability. The blanket grant does NOT include
  // writes — connected is not the same as authorized to publish.
  return caps.has(meta.capability);
}

/**
 * Evaluate a GitHub tool call: licensed? does it pause for approval? External
 * writes (branch/issue/comment/PR/merge) require approval by default; reads do
 * not. Merge is the most consequential.
 */
function evaluateGithubAction(tool, capabilities) {
  const meta = GITHUB_TOOLS[tool];
  if (!meta) {
    return { allowed: false, requiresApproval: true, write: false, reason: `unknown github tool: ${tool}` };
  }
  const allowed = githubToolAllowed(tool, capabilities);
  return {
    allowed,
    write: meta.write,
    // Every external write is a human decision by default.
    requiresApproval: meta.write === true,
    reason: allowed ? "" : `tool not permitted for this task (${meta.capability})`,
  };
}

/** Bound untrusted text so a huge issue/PR body never floods model context. */
function boundText(value, max = 4000) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

/**
 * Low-level API call. The token is resolved via the injected resolver and used
 * ONLY in the Authorization header. It is never returned, logged, or embedded
 * in an error. On any failure the caller gets a status + a short, token-free
 * message.
 */
async function githubRequest({ path, method = "GET", body, resolveToken, authRef, fetchImpl, signal }) {
  const doFetch = fetchImpl || fetch;
  let token = null;
  try {
    token = await resolveToken?.(authRef);
  } catch {
    token = null;
  }
  if (signal?.aborted) return { ok: false, status: 0, error: "cancelled", cancelled: true };
  if (!token) return { ok: false, status: 401, error: "github_not_connected" };
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
    "User-Agent": "LYKN",
  };
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await doFetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (signal?.aborted || e?.name === "AbortError") {
      return { ok: false, status: 0, error: "cancelled", cancelled: true };
    }
    // Never let a thrown error carry the header/token; report shape only.
    return { ok: false, status: 0, error: "github_request_failed" };
  }
  if (signal?.aborted) return { ok: false, status: 0, error: "cancelled", cancelled: true };
  const status = res.status;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      status,
      error: "github_api_error",
      message: boundText(data?.message || `HTTP ${status}`, 300),
    };
  }
  return { ok: true, status, data };
}

function parseRepo(args) {
  const owner = String(args.owner || "").trim();
  const repo = String(args.repo || "").trim();
  return { owner, repo, valid: /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo) };
}

/**
 * Run one GitHub tool with full capability + approval enforcement in code.
 *
 * @param {string} tool
 * @param {object} args
 * @param {object} deps
 * @param {string[]} deps.capabilities
 * @param {(authRef: object) => Promise<string|null>} deps.resolveToken
 * @param {object} [deps.authRef]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(request: object) => Promise<boolean>} [deps.onApproval]
 * @param {boolean} [deps.approved]  pre-approved (e.g. resumed after approval)
 * @returns {Promise<object>}
 */
async function runGithubTool(tool, args = {}, deps = {}) {
  const { capabilities = [], resolveToken, authRef, fetchImpl, onApproval, approved, signal } = deps;
  if (signal?.aborted) return { ok: false, status: "cancelled", error: "cancelled", ignored: true };
  const meta = GITHUB_TOOLS[tool];
  if (!meta) return { ok: false, error: "unknown_tool", tool };

  const evaln = evaluateGithubAction(tool, capabilities);
  if (!evaln.allowed) {
    return { ok: false, error: "capability_denied", reason: evaln.reason, tool };
  }

  if (evaln.requiresApproval && approved !== true) {
    let ok = false;
    if (typeof onApproval === "function") {
      ok = await onApproval({
        tool,
        write: true,
        action: describeGithubAction(tool, args),
        question: `Approve GitHub action: ${describeGithubAction(tool, args)}?`,
      }).catch(() => false);
    }
    if (!ok) {
      return {
        ok: false,
        status: "waiting_for_approval",
        needsApproval: true,
        tool,
        question: `Approve GitHub action: ${describeGithubAction(tool, args)}?`,
      };
    }
  }

  const call = async (path, method, body) => {
    const result = await githubRequest({ path, method, body, resolveToken, authRef, fetchImpl, signal });
    if (signal?.aborted || result.cancelled) {
      return { ok: false, status: 0, error: "cancelled", cancelled: true };
    }
    return result;
  };
  const finish = (value) =>
    signal?.aborted
      ? { ok: false, status: "cancelled", error: "cancelled", ignored: true }
      : value;

  switch (tool) {
    case "github_get_repo": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const r = await call(`/repos/${owner}/${repo}`);
      if (!r.ok) return r;
      const d = r.data;
      return {
        ok: true,
        untrusted: true,
        repo: {
          fullName: d.full_name,
          description: boundText(d.description, 500),
          defaultBranch: d.default_branch,
          private: d.private,
          openIssues: d.open_issues_count,
          stars: d.stargazers_count,
        },
      };
    }
    case "github_get_issue": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const number = Number(args.number);
      const r = await call(`/repos/${owner}/${repo}/issues/${number}`);
      if (!r.ok) return r;
      const d = r.data;
      return {
        ok: true,
        untrusted: true,
        issue: {
          number: d.number,
          title: boundText(d.title, 300),
          state: d.state,
          body: boundText(d.body),
          author: d.user?.login,
          labels: (d.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
        },
      };
    }
    case "github_list_issues": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const state = ["open", "closed", "all"].includes(String(args.state)) ? args.state : "open";
      const r = await call(`/repos/${owner}/${repo}/issues?state=${state}&per_page=20`);
      if (!r.ok) return r;
      return {
        ok: true,
        untrusted: true,
        issues: (r.data || [])
          .filter((i) => !i.pull_request)
          .map((i) => ({ number: i.number, title: boundText(i.title, 200), state: i.state })),
      };
    }
    case "github_get_pull_request": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const number = Number(args.number);
      const r = await call(`/repos/${owner}/${repo}/pulls/${number}`);
      if (!r.ok) return r;
      const d = r.data;
      return {
        ok: true,
        untrusted: true,
        pullRequest: {
          number: d.number,
          title: boundText(d.title, 300),
          state: d.state,
          body: boundText(d.body),
          head: d.head?.ref,
          base: d.base?.ref,
          merged: d.merged,
          mergeable: d.mergeable,
        },
      };
    }
    case "github_list_pull_requests": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const state = ["open", "closed", "all"].includes(String(args.state)) ? args.state : "open";
      const r = await call(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`);
      if (!r.ok) return r;
      return {
        ok: true,
        untrusted: true,
        pullRequests: (r.data || []).map((p) => ({
          number: p.number,
          title: boundText(p.title, 200),
          state: p.state,
          head: p.head?.ref,
          base: p.base?.ref,
        })),
      };
    }
    case "github_get_checks": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const ref = String(args.ref || "").trim();
      if (!ref) return { ok: false, error: "missing_ref" };
      const r = await call(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`);
      if (!r.ok) return r;
      return {
        ok: true,
        untrusted: true,
        checks: (r.data?.check_runs || []).map((c) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
        })),
      };
    }
    case "github_get_file": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const filePath = String(args.path || "").replace(/^\/+/, "");
      const refQ = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
      const r = await call(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}${refQ}`);
      if (!r.ok) return r;
      const content =
        r.data?.encoding === "base64" && typeof r.data.content === "string"
          ? Buffer.from(r.data.content, "base64").toString("utf8")
          : "";
      return { ok: true, untrusted: true, path: filePath, content: boundText(content, 8000) };
    }
    case "github_search": {
      const q = String(args.query || "").trim();
      if (!q) return { ok: false, error: "missing_query" };
      const type = ["code", "issues", "repositories"].includes(String(args.type)) ? args.type : "code";
      const r = await call(`/search/${type}?q=${encodeURIComponent(q)}&per_page=15`);
      if (!r.ok) return r;
      return {
        ok: true,
        untrusted: true,
        results: (r.data?.items || []).slice(0, 15).map((i) => ({
          name: i.name || i.title || i.full_name,
          path: i.path,
          repo: i.repository?.full_name || i.full_name,
          number: i.number,
        })),
      };
    }
    case "github_create_branch": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const branch = String(args.branch || "").trim();
      const fromSha = String(args.sha || "").trim();
      if (!branch || !fromSha) return { ok: false, error: "missing_branch_or_sha" };
      const r = await call(`/repos/${owner}/${repo}/git/refs`, "POST", {
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      });
      if (!r.ok) return r;
      return finish({ ok: true, branch, ref: r.data?.ref });
    }
    case "github_create_issue": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const title = String(args.title || "").trim();
      if (!title) return { ok: false, error: "missing_title" };
      const r = await call(`/repos/${owner}/${repo}/issues`, "POST", {
        title,
        body: String(args.body || ""),
      });
      if (!r.ok) return r;
      return finish({ ok: true, number: r.data?.number, url: r.data?.html_url });
    }
    case "github_comment": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const number = Number(args.number);
      const bodyText = String(args.body || "").trim();
      if (!number || !bodyText) return { ok: false, error: "missing_number_or_body" };
      const r = await call(`/repos/${owner}/${repo}/issues/${number}/comments`, "POST", {
        body: bodyText,
      });
      if (!r.ok) return r;
      return finish({ ok: true, id: r.data?.id, url: r.data?.html_url });
    }
    case "github_create_pull_request": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const title = String(args.title || "").trim();
      const head = String(args.head || "").trim();
      const base = String(args.base || "").trim();
      if (!title || !head || !base) return { ok: false, error: "missing_pr_fields" };
      const r = await call(`/repos/${owner}/${repo}/pulls`, "POST", {
        title,
        head,
        base,
        body: String(args.body || ""),
      });
      if (!r.ok) return r;
      return finish({ ok: true, number: r.data?.number, url: r.data?.html_url });
    }
    case "github_merge_pull_request": {
      const { owner, repo, valid } = parseRepo(args);
      if (!valid) return { ok: false, error: "invalid_repo" };
      const number = Number(args.number);
      if (!number) return { ok: false, error: "missing_number" };
      const method = ["merge", "squash", "rebase"].includes(String(args.method)) ? args.method : "merge";
      const r = await call(`/repos/${owner}/${repo}/pulls/${number}/merge`, "PUT", {
        merge_method: method,
      });
      if (!r.ok) return r;
      return finish({ ok: true, merged: r.data?.merged === true, sha: r.data?.sha });
    }
    default:
      return { ok: false, error: "unknown_tool", tool };
  }
}

/** Human-readable description for an approval card. Never includes a token. */
function describeGithubAction(tool, args = {}) {
  const repo = args.owner && args.repo ? `${args.owner}/${args.repo}` : "the repository";
  switch (tool) {
    case "github_create_branch":
      return `create branch ${args.branch || ""} in ${repo}`;
    case "github_create_issue":
      return `open an issue in ${repo}: "${boundText(args.title, 80)}"`;
    case "github_comment":
      return `post a comment on ${repo}#${args.number}`;
    case "github_create_pull_request":
      return `open a pull request in ${repo} (${args.head || "?"} → ${args.base || "?"})`;
    case "github_merge_pull_request":
      return `merge pull request ${repo}#${args.number}`;
    default:
      return `${tool} on ${repo}`;
  }
}

export {
  GITHUB_API_BASE,
  GITHUB_TOOLS,
  githubToolAllowed,
  evaluateGithubAction,
  runGithubTool,
  githubRequest,
  describeGithubAction,
  boundText,
};
