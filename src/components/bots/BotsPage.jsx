// LYKN Bots — always-on agents you build once and message like coworkers.
//
// This window IS the builder — pick a look, name it, tell it how to work.
// That becomes a durable persona (src/lib/bots/botStore.ts) paired with one
// worker agent in electron/agentRuntime.cjs. There is no bot page beyond
// this: every conversation happens in the regular chat (pick the Bot from
// the chat bar's Bot menu), and the team strip below the builder is where
// existing Bots live and can be dismissed. All state and runtime wiring
// live in the shared botsClient singleton, so this window and the home chat
// bar's Bot dropdown are two views of the same team.
import { useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2, X, Zap } from "lucide-react";
import BotAvatar, { BOT_QUIRKS, botMood, botPresence } from "@/components/bots/BotAvatar";
import { inkById, inkColor } from "@/lib/appearance";
import { useAppearance } from "@/lib/useAppearance";
import {
  BOT_COLOR_DEFAULT,
  BOT_COLORS,
  BOT_EYES,
  BOT_FACES,
  botSeed,
} from "@/lib/bots/botStore";
import { addBot, botsAvailable, removeBot, setBotConnectionIds, useBots } from "@/lib/bots/botsClient";
import { mcpFetch } from "@/lib/mcp/mcpApi";
import {
  createRoutine,
  deleteRoutine,
  routinesAvailable,
  runRoutineNow,
  setRoutineEnabled,
  useRoutines,
} from "@/lib/routines/routinesClient";

export default function BotsPage() {
  const desktop = botsAvailable();
  const { bots, agentStates, live } = useBots();
  // Which Bot's routines are open below the team strip. Clicking a chip
  // selects it; dismissing a Bot clears a stale selection.
  const [selectedBotId, setSelectedBotId] = useState("");
  const selectedBot = bots.find((b) => b.id === selectedBotId) || null;

  if (!desktop) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-sm font-medium text-black/70 dark:text-white/80">
            Bots live in the LYKN desktop shell
          </p>
          <p className="mt-1 text-xs text-black/45 dark:text-white/45">
            They need the agent runtime to do real work.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto text-black/80 dark:text-white/85">
      <BotBuilder first={bots.length === 0} onCreate={(draft) => addBot(draft)} />

      {/* The team — every Bot you've built. Talk to them from the chat bar. */}
      {bots.length > 0 ? (
        <div className="mx-auto max-w-md px-6 pb-10">
          <p className="text-center text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
            Your Bots
          </p>
          <p className="mt-1 text-center text-[0.72rem] text-black/40 dark:text-white/40">
            Message them from the Bot menu next to the chat bar.
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {bots.map((bot) => {
              const agent = agentStates[bot.agentId];
              const liveState = live[bot.agentId];
              const presence = botPresence(bot, agent, liveState);
              const selected = bot.id === selectedBotId;
              return (
                <span
                  key={bot.id}
                  className={`group flex cursor-pointer items-center gap-2 rounded-full py-1.5 pl-2 pr-2.5 transition-colors ${
                    selected
                      ? "bg-black/[0.09] ring-1 ring-black/20 dark:bg-white/[0.12] dark:ring-white/25"
                      : "bg-black/[0.045] hover:bg-black/[0.07] dark:bg-white/[0.07] dark:hover:bg-white/[0.1]"
                  }`}
                  onClick={() => setSelectedBotId(selected ? "" : bot.id)}
                >
                  <BotAvatar
                    face={bot.face}
                    eyes={bot.eyes}
                    color={bot.color}
                    size={24}
                    mood={botMood(bot, agent, liveState)}
                    seed={botSeed(bot.id)}
                  />
                  <span className="text-[0.78rem] font-medium">{bot.name}</span>
                  <span
                    title={presence.label}
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${presence.dot}`}
                  />
                  <button
                    type="button"
                    title={`Dismiss ${bot.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (selectedBotId === bot.id) setSelectedBotId("");
                      removeBot(bot.id);
                    }}
                    className="rounded-full p-0.5 text-black/30 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100 dark:text-white/30"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
          {selectedBot ? <BotConnections bot={selectedBot} /> : null}
          {selectedBot && routinesAvailable() ? <BotRoutines bot={selectedBot} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function BotConnections({ bot }) {
  const [connections, setConnections] = useState([]);
  useEffect(() => {
    let cancelled = false;
    mcpFetch("/api/mcp/connections")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setConnections(Array.isArray(data.connections) ? data.connections : []);
      })
      .catch(() => {
        if (!cancelled) setConnections([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const assigned = Array.isArray(bot.connectionIds) ? bot.connectionIds : null;
  const toggle = (id) => {
    const current = assigned == null ? connections.map((conn) => conn.id) : [...assigned];
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    setBotConnectionIds(bot.id, next);
  };

  return (
    <div className="mt-6 rounded-2xl border border-black/10 p-4 dark:border-white/10">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
        Connections
      </p>
      <p className="mt-1 text-[0.72rem] text-black/40 dark:text-white/40">
        {assigned == null
          ? `${bot.name} can use every connected app until you pick a subset.`
          : assigned.length === 0
            ? `${bot.name} cannot use external apps.`
            : `${bot.name} can only use the checked connections.`}
      </p>
      {connections.length === 0 ? (
        <p className="mt-3 text-[0.78rem] text-black/40">No MCP connections yet.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {connections.map((conn) => {
            const checked = assigned == null || assigned.includes(conn.id);
            return (
              <li key={conn.id}>
                <label className="flex items-center gap-2 text-[0.8rem]">
                  <input type="checkbox" checked={checked} onChange={() => toggle(conn.id)} />
                  <span className="truncate">{conn.accountLabel || conn.name}</span>
                  <span className="text-[0.68rem] text-black/40">{statusDot(conn.status)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function statusDot(status) {
  if (status === "connected") return "Connected";
  if (status === "authentication_required" || status === "authorizing") return "Needs connect";
  return "Offline";
}

/* ── Routines — standing work this Bot runs on its own ──────────────────── */

function timeAgo(iso) {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

const RUN_STATUS_LABEL = {
  running: "Running…",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  missed: "Missed (asleep)",
  skipped: "Skipped (busy)",
  waiting_for_user: "Needs you",
  waiting_for_approval: "Needs approval",
};

function BotRoutines({ bot }) {
  const routines = useRoutines(bot.id);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    const instruction = draft.trim();
    if (!instruction || creating) return;
    setCreating(true);
    setError("");
    const result = await createRoutine({
      instruction,
      botId: bot.id,
      connectionIds: bot.connectionIds,
      bot: {
        id: bot.id,
        name: bot.name,
        persona: bot.persona,
        face: bot.face,
        eyes: bot.eyes,
        color: bot.color,
        chatId: bot.chatId || "",
      },
    });
    setCreating(false);
    if (result?.ok) {
      setDraft("");
    } else {
      setError(
        String(result?.error || "").startsWith("could_not_parse_trigger")
          ? "Say when it should run — like “every weekday at 8”, “when a PDF appears in Downloads”, or “watch this page”."
          : result?.error || "Could not create that routine.",
      );
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-black/10 p-4 dark:border-white/10">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
        {bot.name}&rsquo;s routines
      </p>
      <p className="mt-1 text-[0.72rem] text-black/40 dark:text-white/40">
        Standing work {bot.name} runs on its own — on a schedule, or when something happens.
      </p>

      {routines.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {routines.map((routine) => (
            <RoutineRow key={routine.id} routine={routine} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[0.78rem] text-black/40 dark:text-white/45">
          No routines yet.
        </p>
      )}

      <div className="mt-3">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder={`e.g. Every weekday at 8, check competitor pricing`}
          maxLength={600}
          className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-[0.8rem] outline-none placeholder:text-black/30 focus:border-black/25 dark:border-white/10 dark:placeholder:text-white/30 dark:focus:border-white/30"
        />
        {error ? (
          <p className="mt-1.5 text-[0.72rem] text-red-500/90">{error}</p>
        ) : (
          <p className="mt-1.5 text-[0.72rem] text-black/35 dark:text-white/35">
            Describe the work and when — press Enter to add it.
          </p>
        )}
      </div>
    </div>
  );
}

function RoutineRow({ routine }) {
  const lastRun = routine.lastRunAt ? new Date(routine.lastRunAt).toLocaleString() : "";
  const lastChecked = routine.lastCheckedAt ? timeAgo(routine.lastCheckedAt) : "";
  const [connections, setConnections] = useState([]);
  useEffect(() => {
    mcpFetch("/api/mcp/connections")
      .then((res) => res.json())
      .then((data) => setConnections(Array.isArray(data.connections) ? data.connections : []))
      .catch(() => setConnections([]));
  }, []);
  const assignedId = Array.isArray(routine.connectionIds) ? routine.connectionIds[0] : null;
  const assigned = assignedId ? connections.find((conn) => conn.id === assignedId) : null;
  const needsConnection =
    assignedId && assigned && assigned.status && assigned.status !== "connected";
  return (
    <li
      className={`rounded-xl bg-black/[0.035] px-3 py-2 dark:bg-white/[0.05] ${
        routine.enabled ? "" : "opacity-60"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.8rem] font-medium">{routine.name}</p>
          <p className="truncate text-[0.7rem] text-black/40 dark:text-white/45">
            {routine.watchingTarget ? `Watching: ${routine.watchingTarget}` : routine.triggerLabel}
            {routine.running ? " · running now" : ""}
            {routine.watching && !routine.running ? " · watching" : ""}
            {!routine.enabled ? " · paused" : ""}
          </p>
          {assignedId ? (
            <p className="truncate text-[0.68rem] text-black/35 dark:text-white/40">
              Connection: {assigned?.accountLabel || assigned?.name || "Needs connection"}
              {needsConnection ? " · Needs connection" : ""}
            </p>
          ) : (
            <p className="truncate text-[0.68rem] text-black/35 dark:text-white/40">
              Connection: all assigned to this Bot
            </p>
          )}
          {needsConnection ? (
            <button
              type="button"
              className="mt-1 text-[0.68rem] font-medium text-blue-600 dark:text-blue-400"
              onClick={() => {
                window.history.replaceState(null, "", "/settings?section=connections");
                window.dispatchEvent(new Event("lykn-open-connections"));
              }}
            >
              Reconnect
            </button>
          ) : null}
          {routine.watchingCondition ? (
            <p className="truncate text-[0.68rem] text-black/35 dark:text-white/40">
              {routine.watchingCondition}
              {lastChecked ? ` · last checked ${lastChecked}` : ""}
            </p>
          ) : lastRun ? (
            <p className="truncate text-[0.68rem] text-black/35 dark:text-white/40">Last ran {lastRun}</p>
          ) : null}
        </div>
        <button
          type="button"
          title="Run now"
          onClick={() => runRoutineNow(routine.id)}
          className="rounded-full p-1.5 text-black/40 transition-colors hover:bg-black/[0.06] hover:text-black/80 dark:text-white/40 dark:hover:bg-white/[0.09] dark:hover:text-white/90"
        >
          <Zap className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={routine.enabled ? "Pause" : "Resume"}
          onClick={() => setRoutineEnabled(routine.id, !routine.enabled)}
          className="rounded-full p-1.5 text-black/40 transition-colors hover:bg-black/[0.06] hover:text-black/80 dark:text-white/40 dark:hover:bg-white/[0.09] dark:hover:text-white/90"
        >
          {routine.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          title="Delete routine"
          onClick={() => deleteRoutine(routine.id)}
          className="rounded-full p-1.5 text-black/30 transition-colors hover:bg-red-500/10 hover:text-red-500 dark:text-white/30"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

export { RUN_STATUS_LABEL };

/* ── The builder — look, name, instructions. That becomes the agent. ────── */

/** A picker chip that is itself a live mini-character. */
function PartChip({ on, title, onPick, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onPick}
      className={`grid aspect-square place-items-center rounded-xl transition-all ${
        on
          ? "bg-black/[0.08] shadow-inner ring-2 ring-black/50 dark:bg-white/[0.10] dark:ring-white/60"
          : "hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
      }`}
    >
      {children}
    </button>
  );
}

function BotBuilder({ first = false, onCreate }) {
  const [face, setFace] = useState(BOT_FACES[0].id);
  const [eyes, setEyes] = useState(BOT_EYES[0].id);
  const [color, setColor] = useState(BOT_COLOR_DEFAULT);
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  // The big preview auditions every personality move in turn — spin,
  // squish, wobble, hop — on the demo tempo (one move per cycle).
  const [demoQuirk, setDemoQuirk] = useState(0);
  const nameRef = useRef(null);
  // For the swatch chips — "My accent" resolves to the workspace accent.
  const appearance = useAppearance();

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setDemoQuirk((n) => n + 1), 3200);
    return () => clearInterval(t);
  }, []);

  const create = () => {
    if (!name.trim()) return;
    onCreate({ name, persona, face, eyes, color });
    // Ready for the next one — the new Bot appears in the team strip below.
    setName("");
    setPersona("");
    nameRef.current?.focus();
  };

  return (
    <div className="relative mx-auto flex max-w-md flex-col items-center px-6 pb-8 pt-10">
      {/* Live preview — it blinks back while they build it */}
      <BotAvatar
        face={face}
        eyes={eyes}
        color={color}
        size={104}
        quirk={BOT_QUIRKS[demoQuirk % BOT_QUIRKS.length]}
        className="transition-all duration-300"
      />

      <h1 className="mt-5 text-center text-xl font-semibold tracking-[-0.02em]">
        {first ? "Build your first Bot" : "Build a new Bot"}
      </h1>
      <p className="mt-1.5 max-w-sm text-center text-[0.8rem] leading-relaxed text-black/45 dark:text-white/45">
        Give it a look, a name, and how it should work. Then message it right
        in your chat — pick it from the Bot menu next to the chat bar.
      </p>

      {/* Shape — every chip is that body wearing the current eyes and color */}
      <div className="mt-6 grid w-full grid-cols-8 gap-1.5">
        {BOT_FACES.map((opt, i) => (
          <PartChip
            key={opt.id}
            on={face === opt.id}
            title={opt.name}
            onPick={() => setFace(opt.id)}
          >
            <BotAvatar face={opt.id} eyes={eyes} color={color} size={34} seed={i * 977} />
          </PartChip>
        ))}
      </div>

      {/* Eyes — the current body trying on each eye style */}
      <div className="mt-2 grid w-full grid-cols-8 gap-1.5">
        {BOT_EYES.map((opt, i) => (
          <PartChip
            key={opt.id}
            on={eyes === opt.id}
            title={opt.name}
            onPick={() => setEyes(opt.id)}
          >
            <BotAvatar face={face} eyes={opt.id} color={color} size={34} seed={i * 431 + 89} />
          </PartChip>
        ))}
      </div>

      {/* Color — the same palette as Settings › Appearance message colors */}
      <div className="mt-4 flex w-full flex-wrap justify-center gap-2">
        {BOT_COLORS.map((c) => {
          const hsl = inkColor(inkById(c.id), appearance) || "212 92% 58%";
          const on = color === c.id;
          return (
            <button
              key={c.id}
              type="button"
              title={c.name}
              aria-pressed={on}
              onClick={() => setColor(c.id)}
              className={`h-7 w-7 rounded-full transition-transform ${
                on
                  ? "scale-110 ring-2 ring-black/60 ring-offset-2 ring-offset-transparent dark:ring-white/70"
                  : "hover:scale-105"
              }`}
              style={{ background: `hsl(${hsl})` }}
            />
          );
        })}
      </div>

      {/* Name */}
      <input
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name your Bot"
        maxLength={40}
        className="mt-6 w-full rounded-2xl border border-black/10 bg-transparent px-4 py-2.5 text-center text-[1.05rem] font-medium outline-none placeholder:font-normal placeholder:text-black/30 focus:border-black/25 dark:border-white/10 dark:placeholder:text-white/30 dark:focus:border-white/30"
      />

      {/* Instructions */}
      <textarea
        value={persona}
        onChange={(e) => setPersona(e.target.value)}
        placeholder={`What is ${name.trim() || "it"} responsible for? How should it work, and what always needs your approval?`}
        rows={4}
        maxLength={1200}
        className="mt-3 w-full resize-none rounded-2xl border border-black/10 bg-transparent px-4 py-3 text-[0.85rem] leading-relaxed outline-none placeholder:text-black/30 focus:border-black/25 dark:border-white/10 dark:placeholder:text-white/30 dark:focus:border-white/30"
      />

      <button
        type="button"
        disabled={!name.trim()}
        onClick={create}
        className="mt-5 w-full rounded-2xl bg-black/85 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-black disabled:opacity-35 dark:bg-white dark:text-black dark:hover:bg-white/90"
      >
        {first ? "Meet your Bot" : "Create Bot"}
      </button>
    </div>
  );
}
