/**
 * Local MCP process lifecycle.
 *
 * Lazy start. Bounded crash backoff. Delete/stop kills the child.
 * Never launches every configured server at boot.
 */

import { assertLocalCommandSafe, assertWorkingDirectorySafe } from './commandPolicy.js';
import { resolveEnvCredentialRefs, sanitizedParentEnv, publicEnvCredentialRefs } from './envRefs.js';

const DEFAULT_BACKOFF_MS = Object.freeze([750, 2500, 8000]);
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

export function createLocalMcpProcessManager({
  createTransport,
  resolveCredential,
  maxRestarts = DEFAULT_MAX_RESTARTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  idleShutdownMs = DEFAULT_IDLE_MS,
  now = () => Date.now(),
} = {}) {
  const sessions = new Map();
  const pinned = new Set();
  let stoppingAll = false;

  function get(connectionId) {
    return sessions.get(String(connectionId || '')) || null;
  }

  async function start(connectionId, spec = {}) {
    const id = String(connectionId || '').trim();
    if (!id) throw Object.assign(new Error('missing_connection_id'), { code: 'missing_connection_id' });
    const existing = sessions.get(id);
    if (existing?.transport && existing.state !== 'stopped' && existing.state !== 'error') {
      existing.lastUsedAt = now();
      return existing;
    }
    const commandCheck = assertLocalCommandSafe({
      command: spec.command,
      args: spec.args,
      confirmInstall: spec.confirmInstall !== false,
    });
    if (!commandCheck.ok) {
      const err = new Error(commandCheck.error);
      err.code = commandCheck.error;
      throw err;
    }
    const cwdCheck = assertWorkingDirectorySafe(spec.workingDirectory || spec.cwd);
    if (!cwdCheck.ok) {
      const err = new Error(cwdCheck.error);
      err.code = cwdCheck.error;
      throw err;
    }
    const childEnv = {
      ...sanitizedParentEnv(),
      ...(await resolveEnvCredentialRefs(spec.envCredentialRefs, {
        resolveCredential: resolveCredential
          ? (ref, extra) => resolveCredential(ref, { ...spec, ...extra })
          : undefined,
      })),
    };
    if (typeof createTransport !== 'function') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const transport = new StdioClientTransport({
        command: commandCheck.command,
        args: commandCheck.args,
        env: childEnv,
        cwd: cwdCheck.cwd || undefined,
        stderr: 'pipe',
      });
      return attach(id, spec, transport, commandCheck);
    }
    const transport = await createTransport({
      connectionId: id,
      command: commandCheck.command,
      args: commandCheck.args,
      env: childEnv,
      cwd: cwdCheck.cwd,
      spec,
    });
    return attach(id, spec, transport, commandCheck);
  }

  function attach(id, spec, transport, commandCheck) {
    const session = {
      id,
      transport,
      command: commandCheck.command,
      args: commandCheck.args,
      workingDirectory: spec.workingDirectory || spec.cwd || null,
      envCredentialRefs: publicEnvCredentialRefs(spec.envCredentialRefs),
      state: 'running',
      restarts: spec._restarts || 0,
      lastCrashAt: spec._lastCrashAt || 0,
      lastUsedAt: now(),
      startedAt: now(),
      restartTimer: null,
      idleTimer: null,
    };
    sessions.set(id, session);
    const child = transport?.pid != null ? { pid: transport.pid } : transport;
    if (typeof transport?.on === 'function') {
      transport.on('close', () => onChildExit(id, 'close'));
      transport.on('error', () => onChildExit(id, 'error'));
    } else if (typeof transport?.stderr?.on === 'function') {
      /* SDK transport: watch process if exposed */
    }
    if (transport?.process && typeof transport.process.on === 'function') {
      transport.process.on('exit', () => onChildExit(id, 'exit'));
    }
    scheduleIdle(session);
    return { ...session, child };
  }

  function scheduleIdle(session) {
    if (!idleShutdownMs || pinned.has(session.id)) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (pinned.has(session.id)) return;
      if (now() - session.lastUsedAt >= idleShutdownMs) {
        void stop(session.id, { reason: 'idle' });
      }
    }, idleShutdownMs);
  }

  function onChildExit(id, reason) {
    const session = sessions.get(id);
    if (!session || session.state === 'stopped' || stoppingAll) return;
    session.state = 'crashed';
    session.lastCrashAt = now();
    session.lastError = reason;
    if (session.restarts >= maxRestarts) {
      session.state = 'error';
      return;
    }
    const wait = backoffMs[Math.min(session.restarts, backoffMs.length - 1)];
    session.restarts += 1;
    session.restartTimer = setTimeout(() => {
      void start(id, {
        command: session.command,
        args: session.args,
        workingDirectory: session.workingDirectory,
        envCredentialRefs: session.envCredentialRefs,
        confirmInstall: true,
        _restarts: session.restarts,
        _lastCrashAt: session.lastCrashAt,
      }).catch(() => {
        session.state = 'error';
      });
    }, wait);
  }

  async function stop(connectionId, { reason = 'stop' } = {}) {
    const id = String(connectionId || '');
    const session = sessions.get(id);
    if (!session) return { ok: true, stopped: false, reason: 'not_running' };
    session.state = 'stopped';
    if (session.restartTimer) clearTimeout(session.restartTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    sessions.delete(id);
    pinned.delete(id);
    try {
      await session.transport?.close?.();
    } catch {
      /* ignore */
    }
    try {
      session.transport?.process?.kill?.('SIGTERM');
    } catch {
      /* ignore */
    }
    return { ok: true, stopped: true, reason };
  }

  async function stopAll() {
    stoppingAll = true;
    const ids = [...sessions.keys()];
    for (const id of ids) {
      await stop(id, { reason: 'shutdown' });
    }
    stoppingAll = false;
    return { ok: true, stopped: ids.length };
  }

  function health(connectionId) {
    const session = get(connectionId);
    if (!session) return { ok: true, live: false, state: 'idle' };
    return {
      ok: true,
      live: session.state === 'running',
      state: session.state,
      restarts: session.restarts,
      pid: session.transport?.pid || session.transport?.process?.pid || null,
    };
  }

  function touch(connectionId) {
    const session = get(connectionId);
    if (session) {
      session.lastUsedAt = now();
      scheduleIdle(session);
    }
  }

  function pin(connectionId) {
    if (connectionId) pinned.add(String(connectionId));
  }

  function unpin(connectionId) {
    pinned.delete(String(connectionId));
  }

  function registerShutdownHooks(proc = process) {
    const onExit = () => {
      void stopAll();
    };
    proc.once?.('exit', onExit);
    proc.once?.('SIGTERM', onExit);
    proc.once?.('SIGINT', onExit);
    return () => {
      proc.off?.('exit', onExit);
      proc.off?.('SIGTERM', onExit);
      proc.off?.('SIGINT', onExit);
    };
  }

  return {
    start,
    stop,
    stopAll,
    health,
    touch,
    pin,
    unpin,
    get,
    registerShutdownHooks,
    listLive() {
      return [...sessions.keys()];
    },
  };
}
