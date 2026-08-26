"use strict";

/**
 * Remote consequence + capability policy — enforced in code, never in prompt.
 *
 * Two independent gates decide whether a remote command may run and whether it
 * pauses for a human:
 *
 *   1. CAPABILITY  — does the Task's capability envelope license the SHAPE of
 *      this operation at all? A diagnostic Task holding only remote.connect /
 *      remote.read / remote.shell.read can never run a mutating command, no
 *      matter what the model asks for.
 *
 *   2. CONSEQUENCE — given the target's ENVIRONMENT (development / staging /
 *      production / unknown), is this a read, ordinary reversible work, or a
 *      consequential action that must be approved by a human?
 *
 * The environment is authoritative RemoteTarget/runtime configuration. It
 * arrives here from the resolved target record, never from the Task objective
 * or the model, so a model can never silently relabel a production host as
 * development to dodge approval (see remoteTarget.cjs — environment is not a
 * model-writable field).
 *
 * The classifier is consequence-based, mirroring electron/localSystem.cjs:
 * "production" does NOT mean "approve every ls". Reads and diagnostics run
 * unattended everywhere. What changes with environment is the middle tier —
 * ordinary mutating development work (installs, dev-service restarts, builds)
 * is autonomous in development/staging when the Task licenses it, but on
 * production and unknown hosts it becomes consequential and pauses.
 */

// ── Capability grammar ───────────────────────────────────────────────────────

const REMOTE_BLANKET = new Set(["remote", "remote_ssh"]);

const REMOTE_CAPABILITIES = Object.freeze([
  "remote.connect",
  "remote.read",
  "remote.shell.read",
  "remote.shell.execute",
  "remote.write",
  "remote.process.manage",
  "remote.deploy",
  "remote.files.delete",
]);

/** Structured remote tool names the executor exposes. */
const REMOTE_TOOLS = Object.freeze([
  "remote_exec",
  "remote_read_file",
  "remote_list_dir",
  "remote_search",
  "remote_write_file",
]);

function capList(capabilities) {
  return Array.isArray(capabilities) ? capabilities.map(String).filter(Boolean) : [];
}

function hasAny(capabilities, names) {
  const caps = new Set(capList(capabilities));
  return names.some((name) => caps.has(name));
}

function hasBlanket(capabilities) {
  return capList(capabilities).some((cap) => REMOTE_BLANKET.has(cap));
}

/** Does the Task hold ANY remote capability at all? */
function hasRemoteCapability(capabilities) {
  const caps = capList(capabilities);
  if (!caps.length) return false;
  if (hasBlanket(caps)) return true;
  return caps.some((cap) => REMOTE_CAPABILITIES.includes(cap));
}

/**
 * Which structured tools a capability set licenses. Returns null when the Task
 * holds no remote capability (the executor must refuse to run it).
 */
function allowedRemoteTools(capabilities) {
  const caps = capList(capabilities);
  if (!hasRemoteCapability(caps)) return null;
  if (hasBlanket(caps)) return new Set(REMOTE_TOOLS);

  const allowed = new Set();
  // Any remote capability implies the ability to connect and read structured
  // file listings/contents — you cannot operate a host you cannot inspect.
  if (
    hasAny(caps, [
      "remote.read",
      "remote.shell.read",
      "remote.shell.execute",
      "remote.write",
      "remote.process.manage",
      "remote.deploy",
      "remote.files.delete",
    ])
  ) {
    allowed.add("remote_read_file");
    allowed.add("remote_list_dir");
    allowed.add("remote_search");
  }
  if (
    hasAny(caps, [
      "remote.shell.read",
      "remote.shell.execute",
      "remote.process.manage",
      "remote.deploy",
      "remote.files.delete",
    ])
  ) {
    allowed.add("remote_exec");
  }
  if (hasAny(caps, ["remote.write"])) {
    allowed.add("remote_write_file");
  }
  return allowed;
}

// ── Consequence classification ───────────────────────────────────────────────

const ENVIRONMENTS = Object.freeze(["development", "staging", "production", "unknown"]);

/** Read-only / diagnostic command prefixes. Auto-run in EVERY environment. */
const READ_ONLY_PREFIXES = [
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "which", "whoami", "id", "date", "uname", "uptime", "hostname", "free",
  "echo", "printenv", "env", "grep", "egrep", "rg", "find", "tree", "diff",
  "ps", "top -b", "htop -b", "netstat", "ss", "lsof", "vmstat", "iostat",
  "journalctl", "dmesg", "tailf",
  "systemctl status", "systemctl is-active", "systemctl is-enabled",
  "systemctl list-units", "service --status-all",
  "docker ps", "docker images", "docker logs", "docker inspect",
  "docker compose ps", "docker compose logs", "docker-compose ps", "docker-compose logs",
  "kubectl get", "kubectl describe", "kubectl logs", "kubectl top",
  "git status", "git log", "git diff", "git branch", "git show", "git remote",
  "git rev-parse", "git describe", "git fetch --dry-run",
  "npm ls", "npm view", "npm outdated", "node --version", "npm --version",
  "python3 --version", "pip list", "pip freeze",
  "cat /etc", "readlink", "realpath", "basename", "dirname",
];

/**
 * ALWAYS-CONSEQUENTIAL patterns — commitment, irreversibility, credentials,
 * privilege escalation, security config, or external state change. These
 * require live human approval in EVERY environment, standing authorization or
 * not. Environment can raise strictness elsewhere; nothing lowers it here.
 */
const CONSEQUENTIAL_PATTERNS = [
  /\bsudo\b/i,
  /\brm\b|\brmdir\b|\bshred\b|\bsrm\b|\bunlink\b/i,
  /\bchmod\b|\bchown\b|\bchgrp\b|\bsetfacl\b/i,
  /\bkill(all)?\b|\bpkill\b/i,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b|\binit\s+[06]\b/i,
  /\bmkfs\b|\bdd\b|\bfdisk\b|\bparted\b|\bmount\b|\bumount\b/i,
  /\bcrontab\b|\bat\s+now\b/i,
  /\bpasswd\b|\buseradd\b|\buserdel\b|\busermod\b|\bgroupadd\b|\bdeluser\b|\badduser\b/i,
  /\bufw\b|\biptables\b|\bnft\b|\bfirewall-cmd\b/i,
  // Persistent service CONFIG changes (unlike a restart, these outlive reboot).
  /\bsystemctl\s+(enable|disable|mask|unmask)\b/i,
  /\b(docker|docker-compose)\s+(compose\s+)?(down|rm|kill|prune)\b/i,
  /\bdocker\s+(rmi|volume\s+rm|network\s+rm|system\s+prune)\b/i,
  /\bkubectl\s+(delete|drain|cordon)\b/i,
  /\bhelm\s+(uninstall|delete)\b/i,
  /\bterraform\s+destroy\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(npm|yarn|pnpm)\s+(publish|unpublish|deprecate)\b/i,
  /\b(npm|yarn|pnpm)\s+(login|adduser|token)\b/i,
  /curl[^|;&]*\|\s*(ba|z)?sh/i,
  /wget[^|;&]*\|\s*(ba|z)?sh/i,
  /\btruncate\b/i,
  /\bmkfifo\b|\bmknod\b/i,
  // Database mutations (schema/data). Read queries are hard to prove safe over
  // shell, so any psql/mysql/mongo invocation carrying a mutating verb is
  // consequential; a bare interactive client is caught by the fallthrough.
  /\b(psql|mysql|mongosh?|redis-cli|sqlite3)\b[^\n]*\b(drop|delete|truncate|update|insert|alter|create|grant|revoke|flushall|flushdb)\b/i,
  /\b(migrate|db:migrate|alembic\s+upgrade|flyway\s+migrate|prisma\s+migrate)\b/i,
];

/**
 * PROCESS-MANAGEMENT patterns — service restarts and reloads. Reversible
 * operational work: autonomous in development/staging when the Task holds
 * remote.process.manage ("SSH into dev-server and fix the failing service"),
 * consequential on production/unknown ("LYKN wants to restart the Production
 * API — Approve?").
 */
const PROCESS_PATTERNS = [
  /\bsystemctl\s+(restart|stop|start|reload)\b/i,
  /\bservice\s+\S+\s+(restart|stop|start|reload)\b/i,
  /\bdocker\s+(restart|start|stop)\b/i,
  /\b(docker|docker-compose)\s+(compose\s+)?(up|restart|start|stop)\b/i,
  /\bpm2\s+(restart|reload|start|stop|delete)\b/i,
  /\bsupervisorctl\s+(restart|start|stop)\b/i,
];

/**
 * DEPLOY patterns — pushing new software/infrastructure state. Autonomous only
 * in DEVELOPMENT with remote.deploy; staging and production always pause
 * ("deploy to staging may still require approval based on policy").
 */
const DEPLOY_PATTERNS = [
  /\bkubectl\s+(apply|scale|rollout|patch|replace|edit)\b/i,
  /\bhelm\s+(install|upgrade|rollback)\b/i,
  /\bterraform\s+(apply|import)\b/i,
  /\bansible(-playbook)?\b/i,
  /\bdeploy\b|\bcap\s+\w+\s+deploy\b|\bkamal\s+deploy\b/i,
];

/**
 * ROUTINE (mutating development) patterns — reversible work a capable dev agent
 * does without a pause in development/staging. On production/unknown these
 * become consequential (see classifyRemoteCommand).
 */
const ROUTINE_DEV_PATTERNS = [
  /\b(npm|yarn|pnpm)\s+(install|i|ci|add|remove|uninstall|update|run|test|build|lint|exec)\b/i,
  /\b(pip3?|poetry|pipenv)\s+(install|uninstall|add|remove|sync)\b/i,
  /\b(bundle|gem)\s+(install|update)\b/i,
  /\b(go|cargo|mvn|gradle|make|cmake|composer)\b/i,
  /\bgit\s+(add|commit|checkout|switch|stash|pull|fetch|clone|restore|tag)\b/i,
  /\b(mkdir|touch|cp|mv|ln|tee)\b/i,
  /\b(nvm|rbenv|pyenv|asdf)\b/i,
  />/, // output redirection into a working file
];

/**
 * Classify one remote command by consequence, environment-aware.
 *
 * opClass identifies which capability licenses the SHAPE:
 *   "read" → remote.shell.read, "shell" → remote.shell.execute,
 *   "process" → remote.process.manage, "deploy" → remote.deploy.
 *
 * @param {string} command
 * @param {{ environment?: string }} [opts]
 * @returns {{ tier: "read"|"routine"|"consequential", opClass: string,
 *   readOnly: boolean, requiresApproval: boolean, reason: string }}
 */
function classifyRemoteCommand(command, { environment = "unknown" } = {}) {
  const cmd = String(command || "").trim();
  const env = ENVIRONMENTS.includes(String(environment)) ? String(environment) : "unknown";
  if (!cmd) {
    return { tier: "consequential", opClass: "shell", readOnly: false, requiresApproval: true, reason: "empty command" };
  }

  // Always-consequential wins in every environment. A routine command chained
  // with a consequential one (`npm test && rm -rf dist`) stays consequential
  // because the pattern matches the whole string.
  const consequential = CONSEQUENTIAL_PATTERNS.find((re) => re.test(cmd));
  if (consequential) {
    return {
      tier: "consequential",
      opClass: "shell",
      readOnly: false,
      requiresApproval: true,
      reason: `consequential (${String(consequential).slice(0, 40)})`,
    };
  }

  const lower = cmd.toLowerCase();
  const readOnly = READ_ONLY_PREFIXES.some((p) => lower === p || lower.startsWith(p + " "));
  if (readOnly) {
    return { tier: "read", opClass: "read", readOnly: true, requiresApproval: false, reason: "read-only diagnostic" };
  }

  if (PROCESS_PATTERNS.some((re) => re.test(cmd))) {
    // Service restarts: autonomous on dev/staging, approval on prod/unknown.
    const requiresApproval = env === "production" || env === "unknown";
    return {
      tier: requiresApproval ? "consequential" : "routine",
      opClass: "process",
      readOnly: false,
      requiresApproval,
      reason: requiresApproval
        ? `service management on a ${env} host requires approval`
        : "service management on a development host",
    };
  }

  if (DEPLOY_PATTERNS.some((re) => re.test(cmd))) {
    // Deployments: autonomous only in development; staging/production/unknown
    // pause for a human.
    const requiresApproval = env !== "development";
    return {
      tier: requiresApproval ? "consequential" : "routine",
      opClass: "deploy",
      readOnly: false,
      requiresApproval,
      reason: requiresApproval
        ? `deployment to a ${env} host requires approval`
        : "deployment on a development host",
    };
  }

  const routine = ROUTINE_DEV_PATTERNS.find((re) => re.test(cmd));
  if (routine) {
    // Ordinary mutating dev work: autonomous in dev/staging, approval on
    // production and (conservatively) unknown.
    const requiresApproval = env === "production" || env === "unknown";
    return {
      tier: requiresApproval ? "consequential" : "routine",
      opClass: "shell",
      readOnly: false,
      requiresApproval,
      reason: requiresApproval
        ? `routine dev work requires approval on ${env} host`
        : "routine dev work",
    };
  }

  // Unknown command shape. Never silently run a command we cannot classify as a
  // read on any host: treat as consequential so it pauses for a human.
  return {
    tier: "consequential",
    opClass: "shell",
    readOnly: false,
    requiresApproval: true,
    reason: "unrecognized command shape",
  };
}

/**
 * Whether a command's SHAPE is licensed by the capabilities, independent of the
 * approval decision. remote.shell.read licenses only read-tier commands;
 * remote.shell.execute licenses routine dev work; consequential shapes need the
 * matching mutation capability (process.manage / deploy / files.delete / write)
 * OR the blanket grant, and STILL pause for approval via classifyRemoteCommand.
 *
 * @param {string} command
 * @param {string[]} capabilities
 * @param {{ environment?: string }} [opts]
 */
function remoteCommandPermitted(command, capabilities, { environment = "unknown" } = {}) {
  const caps = capList(capabilities);
  if (!hasRemoteCapability(caps)) return false;
  if (hasBlanket(caps)) return true;
  const { opClass } = classifyRemoteCommand(command, { environment });
  if (opClass === "read") {
    return hasAny(caps, [
      "remote.shell.read",
      "remote.shell.execute",
      "remote.process.manage",
      "remote.deploy",
    ]);
  }
  if (opClass === "process") {
    return hasAny(caps, ["remote.process.manage"]);
  }
  if (opClass === "deploy") {
    return hasAny(caps, ["remote.deploy"]);
  }
  // General shell mutations (routine dev work and consequential shapes) need
  // remote.shell.execute — consequential ones are then still offered to a
  // human for approval, never auto-run.
  return hasAny(caps, ["remote.shell.execute", "remote.files.delete"]);
}

/**
 * Evaluate a structured remote tool call: is it licensed, and does it pause?
 *
 * @param {string} tool one of REMOTE_TOOLS
 * @param {object} args
 * @param {string[]} capabilities
 * @param {{ environment?: string }} [opts]
 * @returns {{ allowed: boolean, requiresApproval: boolean, tier: string,
 *   readOnly: boolean, summary: string, reason: string }}
 */
function evaluateRemoteAction(tool, args = {}, capabilities = [], { environment = "unknown" } = {}) {
  const allowedTools = allowedRemoteTools(capabilities);
  const env = ENVIRONMENTS.includes(String(environment)) ? String(environment) : "unknown";
  if (!allowedTools || !allowedTools.has(tool)) {
    return {
      allowed: false,
      requiresApproval: true,
      tier: "consequential",
      readOnly: false,
      summary: "",
      reason: "tool not permitted for this task",
    };
  }
  switch (tool) {
    case "remote_read_file":
    case "remote_list_dir":
    case "remote_search":
      return {
        allowed: true,
        requiresApproval: false,
        tier: "read",
        readOnly: true,
        summary: "",
        reason: "read-only remote inspection",
      };
    case "remote_write_file": {
      const target = String(args.path || "(unknown path)");
      // Writing to a remote host is ordinary in dev/staging, consequential on
      // production/unknown.
      const requiresApproval = env === "production" || env === "unknown";
      return {
        allowed: true,
        requiresApproval,
        tier: requiresApproval ? "consequential" : "routine",
        readOnly: false,
        summary: `Write remote file on the ${env} host: ${target}`,
        reason: requiresApproval ? `remote write on ${env} host` : "remote dev write",
      };
    }
    case "remote_exec": {
      const command = String(args.command || "");
      const permitted = remoteCommandPermitted(command, capabilities, { environment: env });
      const consequence = classifyRemoteCommand(command, { environment: env });
      return {
        allowed: permitted,
        requiresApproval: consequence.requiresApproval,
        tier: consequence.tier,
        readOnly: consequence.readOnly,
        summary: consequence.requiresApproval ? `Run on the ${env} host: ${command.slice(0, 300)}` : "",
        reason: permitted ? consequence.reason : "shell command not permitted for this task",
      };
    }
    default:
      return {
        allowed: false,
        requiresApproval: true,
        tier: "consequential",
        readOnly: false,
        summary: "",
        reason: `unknown remote tool: ${tool}`,
      };
  }
}

/**
 * Derive a conservative remote capability envelope from an objective.
 * Mirrors compileLocalCapabilities: a diagnostic ask compiles to read-only
 * capabilities; mutation verbs add exactly the class they need; nothing ever
 * silently grants deploy or delete. Explicit capabilities (routine records,
 * saved-target defaults) win outright.
 *
 * @param {string} objective
 * @param {{ explicit?: string[] }} [opts]
 * @returns {string[]}
 */
function compileRemoteCapabilities(objective, { explicit } = {}) {
  const provided = capList(explicit);
  if (provided.length) return provided;
  const text = String(objective || "").toLowerCase();

  // Diagnostic base: any remote ask can connect and inspect.
  const caps = new Set(["remote.connect", "remote.read", "remote.shell.read"]);

  if (/\b(fix|edit|change|update|patch|write|create|add|install|build|run tests?|test|configure|set up|setup)\b/.test(text)) {
    caps.add("remote.shell.execute");
    caps.add("remote.write");
  }
  if (/\b(restart|reload|start|stop)\b[^.]{0,40}\b(service|server|process|api|daemon|worker|app)\b/.test(text) ||
      /\b(service|server|process|api|daemon|worker)\b[^.]{0,40}\b(restart|reload|start|stop)\b/.test(text)) {
    caps.add("remote.process.manage");
  }
  if (/\b(deploy|roll ?out|release|ship)\b/.test(text)) {
    caps.add("remote.deploy");
    caps.add("remote.shell.execute");
  }
  if (/\bdelete\b|\bremove\b[^.]{0,30}\bfiles?\b/.test(text)) {
    caps.add("remote.files.delete");
  }
  return [...caps];
}

module.exports = {
  REMOTE_BLANKET,
  REMOTE_CAPABILITIES,
  REMOTE_TOOLS,
  ENVIRONMENTS,
  READ_ONLY_PREFIXES,
  CONSEQUENTIAL_PATTERNS,
  PROCESS_PATTERNS,
  DEPLOY_PATTERNS,
  ROUTINE_DEV_PATTERNS,
  hasRemoteCapability,
  hasBlanket,
  allowedRemoteTools,
  classifyRemoteCommand,
  remoteCommandPermitted,
  evaluateRemoteAction,
  compileRemoteCapabilities,
};
