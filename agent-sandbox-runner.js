// ============================================================================
// agent-sandbox-runner.js — execute generated agent/handler.mjs in-process
// ============================================================================

import { runChatTool } from './mcp-tools/chatTools.js';
import { buildCapabilitiesAwareFallbackHandler } from './agent-sandbox-fallback-handler.js';
import {
  executeVaultTopicAgent,
  executeVaultInventoryAgent,
  shouldUseVaultTopicExecutor,
  shouldUseVaultInventoryExecutor,
  wantsFullVaultInventory,
} from './agent-vault-search.js';

const HANDLER_TIMEOUT_MS = 180_000;

/**
 * Strip ESM syntax and balance braces so AsyncFunction can eval handler code.
 */
export function prepareHandlerSource(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';

  s = s.replace(/^```(?:javascript|js|mjs)?\s*/im, '').replace(/```\s*$/im, '').trim();
  s = s.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  s = s.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  s = s.replace(/^export\s+default\s+/gm, '');
  s = s.replace(/^export\s+/gm, '');

  if (!/async\s+function\s+__runAgent__/.test(s) && !/async\s+function\s+runAgent/.test(s)) {
    if (/function\s+runAgent/.test(s)) {
      s = s.replace(/function\s+runAgent\s*\(/, 'async function __runAgent__(');
    }
  } else {
    s = s.replace(/async\s+function\s+runAgent\s*\(/g, 'async function __runAgent__(');
    s = s.replace(/function\s+runAgent\s*\(/g, 'async function __runAgent__(');
  }

  const open = (s.match(/\{/g) || []).length;
  const close = (s.match(/\}/g) || []).length;
  if (open > close) s += '\n' + '}'.repeat(open - close);

  if (!/async\s+function\s+__runAgent__/.test(s)) {
    return '';
  }
  return s;
}

export function validateHandlerSource(prepared) {
  if (!prepared) return { ok: false, error: 'empty_handler' };
  try {
    // eslint-disable-next-line no-new-func
    new Function('message', 'tools', 'context', `${prepared}\nreturn null;`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** @deprecated use buildCapabilitiesAwareFallbackHandler */
export function buildFallbackAgentHandler(spec) {
  return buildCapabilitiesAwareFallbackHandler(spec);
}

function summarizeFromToolCalls(toolCalls) {
  const searches = toolCalls.filter((t) => t.tool === 'lykn_searchVault' && t.ok !== false);
  let hitCount = 0;
  for (const s of searches) {
    const hits = s.result?.hits || s.result?.results || [];
    hitCount += Array.isArray(hits) ? hits.length : 0;
  }
  if (hitCount > 0) {
    return `Completed vault search (${hitCount} items found across ${searches.length} queries). See tool log for details — expand handler output if the reply was empty.`;
  }
  return '';
}

/**
 * Run handler source with live LYKN tools (in-process sandbox).
 */
export async function runAgentHandlerSandbox({
  source,
  message,
  ctx,
  contextBlock,
  allowedToolNames = [],
}) {
  let prepared = prepareHandlerSource(source);
  let validation = validateHandlerSource(prepared);
  if (!validation.ok) {
    throw new Error(`Handler syntax invalid: ${validation.error}`);
  }

  const allowed = new Set(allowedToolNames);
  const toolCalls = [];

  const tools = async (name, args = {}) => {
    const toolName = String(name || '').trim();
    if (!toolName) return { ok: false, error: 'missing_tool_name' };
    if (allowed.size && !allowed.has(toolName)) {
      const err = `Tool not allowed: ${toolName}`;
      toolCalls.push({ tool: toolName, args, ok: false, error: err });
      throw new Error(err);
    }
    const r = await runChatTool(toolName, args, ctx);
    const entry = {
      tool: toolName,
      args,
      ok: r.ok && !r.isError,
      isError: r.isError,
      result: r.payload,
      latencyMs: r.latencyMs,
    };
    toolCalls.push(entry);
    if (r.isError) {
      const errMsg = r.payload?.error || r.payload?.message || `Tool failed: ${toolName}`;
      throw new Error(String(errMsg));
    }
    return r.payload;
  };

  const context = {
    beliefs: '',
    project: '',
    synthesis: contextBlock || '',
    /** Safe accessors — use in handler if needed via context.lykn */
    lykn: {
      rulesList: (payload) =>
        Array.isArray(payload?.rules) ? payload.rules : Array.isArray(payload) ? payload : [],
      beliefsList: (payload) =>
        Array.isArray(payload?.beliefs)
          ? payload.beliefs
          : Array.isArray(payload)
            ? payload
            : [],
      vaultHits: (payload) => (Array.isArray(payload?.hits) ? payload.hits : []),
    },
  };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runner = new AsyncFunction(
    'message',
    'tools',
    'context',
    `${prepared}\nreturn await __runAgent__({ message, tools, context });`,
  );

  const result = await Promise.race([
    runner(String(message || ''), tools, context),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Agent handler timed out after 3 minutes')), HANDLER_TIMEOUT_MS);
    }),
  ]);

  let reply = '';
  if (typeof result?.reply === 'string') {
    reply = result.reply.trim();
  } else if (result != null && typeof result === 'object') {
    reply = JSON.stringify(result, null, 2).slice(0, 32_000);
  }

  if (!reply) {
    reply = summarizeFromToolCalls(toolCalls) || '';
  }

  const merged = [
    ...(Array.isArray(result?.toolCalls) ? result.toolCalls : []),
    ...toolCalls,
  ];

  return {
    ok: true,
    reply: reply || 'Agent ran tools but returned no summary text.',
    tool_calls: merged.slice(-48),
    runtime: 'handler',
    tools_invoked: toolCalls.filter((t) => t.ok).length,
  };
}

/** Full vault catalog — recent notes from DB, no keyword filter. */
export async function runVaultInventoryAgentRun({ spec, message, ctx, contextBlock }) {
  const allowed = new Set(spec?.tools || []);
  const toolsFn = async (name, args = {}) => {
    const toolName = String(name || '').trim();
    if (!toolName) throw new Error('missing_tool_name');
    if (allowed.size && !allowed.has(toolName)) {
      throw new Error(`Tool not allowed: ${toolName}`);
    }
    const r = await runChatTool(toolName, args, ctx);
    if (r.isError) {
      throw new Error(String(r.payload?.error || r.payload?.message || `Tool failed: ${toolName}`));
    }
    return r.payload;
  };
  const excludeEmail =
    !wantsFullVaultInventory(message, spec) && !/\b(include|with)\s+(all\s+)?email\b/i.test(message);
  return executeVaultInventoryAgent({
    spec,
    ctx,
    contextBlock,
    excludeEmail,
    toolsFn,
  });
}

/** Smart vault run: UI-focused queries, deprioritize Gmail/email hits. */
export async function runVaultTopicAgentRun({ spec, message, ctx, contextBlock }) {
  const allowed = new Set(spec?.tools || []);
  const toolsFn = async (name, args = {}) => {
    const toolName = String(name || '').trim();
    if (!toolName) throw new Error('missing_tool_name');
    if (allowed.size && !allowed.has(toolName)) {
      throw new Error(`Tool not allowed: ${toolName}`);
    }
    const r = await runChatTool(toolName, args, ctx);
    if (r.isError) {
      throw new Error(String(r.payload?.error || r.payload?.message || `Tool failed: ${toolName}`));
    }
    return r.payload;
  };
  return executeVaultTopicAgent({
    message,
    spec,
    toolsFn,
    contextBlock,
    excludeEmail: true,
  });
}

export async function runAgentHandlerSandboxWithFallback({
  source,
  spec,
  message,
  ctx,
  contextBlock,
}) {
  const allowed = spec?.tools || [];
  try {
    return await runAgentHandlerSandbox({
      source,
      message,
      ctx,
      contextBlock,
      allowedToolNames: allowed,
    });
  } catch (primaryErr) {
    console.warn('[agent-sandbox] primary handler failed:', primaryErr?.message || primaryErr);
    if (shouldUseVaultTopicExecutor(spec, message)) {
      try {
        const topic = await runVaultTopicAgentRun({ spec, message, ctx, contextBlock });
        return {
          ...topic,
          handler_warning: `Generated handler failed (${primaryErr?.message}). Ran topic-focused vault search.`,
        };
      } catch (topicErr) {
        console.warn('[agent-sandbox] vault topic run failed:', topicErr?.message || topicErr);
      }
    }
    const fallback = buildCapabilitiesAwareFallbackHandler(spec);
    try {
      const result = await runAgentHandlerSandbox({
        source: fallback,
        message,
        ctx,
        contextBlock,
        allowedToolNames: allowed,
      });
      return {
        ...result,
        runtime: 'handler-fallback',
        handler_warning: `Generated handler failed (${primaryErr?.message}). Ran built-in vault executor.`,
      };
    } catch (fallbackErr) {
      throw new Error(
        `Sandbox handler failed: ${primaryErr?.message}. Fallback failed: ${fallbackErr?.message}`,
      );
    }
  }
}
