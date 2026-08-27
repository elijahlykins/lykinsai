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
import {
  ArrowDown,
  ArrowUp,
  Circle,
  Pencil,
  Pause,
  Play,
  Save,
  Trash2,
  X,
  Zap,
} from "lucide-react";
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
import {
  applyRecoveredWorkflowUpdate,
  cancelTeaching,
  createRoutineFromWorkflow,
  createWorkflow,
  deleteWorkflow,
  finishTeaching,
  runWorkflow,
  startTeaching,
  updateWorkflow,
  useTeachSession,
  useWorkflows,
  workflowsAvailable,
} from "@/lib/workflows/workflowsClient";

function botSnapshot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    role: bot.role || "",
    persona: bot.persona || "",
    face: bot.face,
    eyes: bot.eyes,
    color: bot.color,
    chatId: bot.chatId || "",
    connectionIds: bot.connectionIds,
  };
}

export default function BotsPage() {
  const desktop = botsAvailable();
  const { bots, agentStates, live } = useBots();
  const teaching = useTeachSession();
  // Which Bot's routines are open below the team strip. Clicking a chip
  // selects it; dismissing a Bot clears a stale selection.
  const [selectedBotId, setSelectedBotId] = useState("");
  const selectedBot = bots.find((b) => b.id === selectedBotId) || null;
  const teachingBot = bots.find((bot) => bot.id === teaching.session?.botId) || null;

  useEffect(() => {
    if (teaching.active && teaching.session?.botId) {
      setSelectedBotId(teaching.session.botId);
    }
  }, [teaching.active, teaching.session?.botId]);

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
      {teaching.active ? (
        <div className="sticky top-3 z-10 mx-auto mt-3 flex max-w-md items-center gap-2 rounded-2xl border border-red-500/20 bg-white/95 px-4 py-2.5 shadow-sm backdrop-blur dark:bg-neutral-950/95">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-40" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.78rem] font-semibold">
              Teaching {teachingBot?.name || "Bot"}
            </p>
            <p className="text-[0.68rem] text-black/40 dark:text-white/45">
              {teaching.session?.eventCount || 0} actions captured
            </p>
          </div>
        </div>
      ) : null}

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
                  onClick={() =>
                    setSelectedBotId(selected && !teaching.active ? "" : bot.id)
                  }
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
                    disabled={teaching.active && teaching.session?.botId === bot.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (selectedBotId === bot.id) setSelectedBotId("");
                      removeBot(bot.id);
                    }}
                    className="rounded-full p-0.5 text-black/30 opacity-0 transition-opacity hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-20 group-hover:opacity-100 dark:text-white/30"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
          {selectedBot ? <BotConnections bot={selectedBot} /> : null}
          {selectedBot && workflowsAvailable() ? <BotWorkflows bot={selectedBot} /> : null}
          {selectedBot && routinesAvailable() ? <BotRoutines bot={selectedBot} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── Teaching and learned workflows ─────────────────────────────────────── */

function BotWorkflows({ bot }) {
  const teaching = useTeachSession();
  const workflows = useWorkflows(bot.id);
  const teachingThisBot = teaching.active && teaching.session?.botId === bot.id;
  const [draftWorkflow, setDraftWorkflow] = useState(null);
  const [editingWorkflow, setEditingWorkflow] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setDraftWorkflow(null);
    setEditingWorkflow(null);
    setMessage("");
  }, [bot.id]);

  const start = async () => {
    if (busy || teaching.active) return;
    setBusy("start");
    setMessage("");
    const input = {
      botId: bot.id,
      agentId: bot.agentId || undefined,
      name: `${bot.name} workflow`,
      objective: `Learn a repeatable workflow for ${bot.name}.`,
      bot: botSnapshot(bot),
    };
    const result = await startTeaching(input);
    setBusy("");
    if (!result?.ok) setMessage(result?.error || "Could not start teaching.");
  };

  const finish = async () => {
    if (busy || !teachingThisBot) return;
    setBusy("finish");
    setMessage("");
    const input = {
      name: `${bot.name} workflow`,
      botId: bot.id,
      bot: botSnapshot(bot),
    };
    const result = await finishTeaching(input);
    setBusy("");
    if (result?.ok && result.workflow) {
      setDraftWorkflow(result.workflow);
      setEditingWorkflow(null);
    } else {
      setMessage(result?.error || "Could not finish teaching.");
    }
  };

  const cancel = async () => {
    if (busy || !teachingThisBot) return;
    setBusy("cancel");
    setMessage("");
    const result = await cancelTeaching();
    setBusy("");
    if (!result?.ok) setMessage(result?.error || "Could not cancel teaching.");
  };

  const saveDraft = async (workflow) => {
    setBusy(`save:${workflow.id}`);
    setMessage("");
    const result = await createWorkflow({ ...workflow, botId: bot.id });
    setBusy("");
    if (result?.ok) {
      setDraftWorkflow(null);
      setMessage("Workflow saved.");
    } else {
      setMessage(result?.error || "Could not save workflow.");
    }
  };

  const saveEdit = async (workflow) => {
    setBusy(`save:${workflow.id}`);
    setMessage("");
    const result = await updateWorkflow(workflow.id, {
      name: workflow.name,
      objective: workflow.objective,
      parameters: workflow.parameters,
      steps: workflow.steps,
      expectedVersion: workflow.version,
    });
    setBusy("");
    if (result?.ok) {
      setEditingWorkflow(null);
      setMessage("Workflow updated.");
    } else {
      setMessage(result?.error || "Could not update workflow.");
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-black/10 p-4 dark:border-white/10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
            {bot.name}&rsquo;s workflows
          </p>
          <p className="mt-1 text-[0.72rem] text-black/40 dark:text-white/40">
            Show {bot.name} a task once, then reuse it.
          </p>
        </div>
        {!teaching.active ? (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void start()}
            className="shrink-0 rounded-xl bg-black/85 px-3 py-1.5 text-[0.72rem] font-semibold text-white transition-colors hover:bg-black disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-white/90"
          >
            Start teaching
          </button>
        ) : null}
      </div>

      {teachingThisBot ? (
        <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.05] p-3">
          <div className="flex items-center gap-2">
            <Circle className="h-2.5 w-2.5 fill-red-500 text-red-500" />
            <p className="flex-1 text-[0.78rem] font-medium">
              Teaching in progress · {teaching.session?.eventCount || 0} actions
            </p>
          </div>
          <p className="mt-1 text-[0.7rem] text-black/45 dark:text-white/45">
            Perform the task normally. Sensitive values are not retained.
          </p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void finish()}
              className="rounded-lg bg-black/85 px-3 py-1.5 text-[0.72rem] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Finish teaching
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void cancel()}
              className="rounded-lg px-3 py-1.5 text-[0.72rem] font-medium text-black/50 hover:bg-black/[0.05] disabled:opacity-40 dark:text-white/55 dark:hover:bg-white/[0.07]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : teaching.active ? (
        <p className="mt-3 rounded-xl bg-black/[0.035] px-3 py-2 text-[0.72rem] text-black/45 dark:bg-white/[0.05] dark:text-white/45">
          Finish or cancel the active teaching session for another Bot before starting one here.
        </p>
      ) : null}

      {draftWorkflow ? (
        <WorkflowEditor
          key={draftWorkflow.id}
          workflow={draftWorkflow}
          title="Review before saving"
          saving={busy === `save:${draftWorkflow.id}`}
          onCancel={() => setDraftWorkflow(null)}
          onSave={saveDraft}
        />
      ) : null}

      {workflows.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {workflows.map((workflow) =>
            editingWorkflow?.id === workflow.id ? (
              <WorkflowEditor
                key={workflow.id}
                workflow={editingWorkflow}
                title="Edit workflow"
                saving={busy === `save:${workflow.id}`}
                onCancel={() => setEditingWorkflow(null)}
                onSave={saveEdit}
              />
            ) : (
              <WorkflowRow
                key={workflow.id}
                workflow={workflow}
                bot={bot}
                busy={busy}
                onBusy={setBusy}
                onMessage={setMessage}
                onEdit={() => {
                  setDraftWorkflow(null);
                  setEditingWorkflow(workflow);
                  setMessage("");
                }}
              />
            ),
          )}
        </ul>
      ) : !draftWorkflow ? (
        <p className="mt-3 text-[0.78rem] text-black/40 dark:text-white/45">
          No saved workflows yet.
        </p>
      ) : null}

      {message ? (
        <p
          className={`mt-2 text-[0.72rem] ${
            /could not|error|failed/i.test(message)
              ? "text-red-500/90"
              : "text-black/40 dark:text-white/45"
          }`}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

function WorkflowRow({ workflow, bot, busy, onBusy, onMessage, onEdit }) {
  const [showRunInputs, setShowRunInputs] = useState(false);
  const [showRoutineInput, setShowRoutineInput] = useState(false);
  const [routineWhen, setRoutineWhen] = useState("");
  const [runValues, setRunValues] = useState(() =>
    Object.fromEntries(
      (workflow.parameters || []).map((parameter) => [
        parameter.name,
        parameter.default === undefined
          ? ""
          : typeof parameter.default === "string"
            ? parameter.default
            : JSON.stringify(parameter.default),
      ]),
    ),
  );
  const act = async (kind, action, success) => {
    if (busy) return;
    onBusy(`${kind}:${workflow.id}`);
    onMessage("");
    const result = await action();
    onBusy("");
    onMessage(result?.ok ? success : result?.error || `Could not ${kind} workflow.`);
    return result;
  };

  const run = async () => {
    const missing = (workflow.parameters || []).find(
      (parameter) => parameter.required && !String(runValues[parameter.name] || "").trim(),
    );
    if (missing) {
      onMessage(`Enter ${missing.name} before running this workflow.`);
      return;
    }
    const parameters = Object.fromEntries(
      Object.entries(runValues).filter(([, value]) => String(value).length > 0),
    );
    const result = await act(
      "run",
      () =>
        runWorkflow(workflow.id, {
          botId: bot.id,
          bot: botSnapshot(bot),
          parameters,
        }),
      "Workflow started.",
    );
    if (result?.ok) setShowRunInputs(false);
  };

  const saveAsRoutine = async (manual = false) => {
    if (!manual && !routineWhen.trim()) {
      onMessage("Describe when this workflow should run.");
      return;
    }
    const result = await act(
      "save as routine",
      () =>
        createRoutineFromWorkflow(workflow.id, {
          botId: bot.id,
          bot: botSnapshot(bot),
          name: workflow.name,
          ...(manual
            ? { trigger: { type: "manual" } }
            : { instruction: routineWhen.trim() }),
          enabled: true,
        }),
      manual ? "Saved as a manual routine." : "Routine scheduled.",
    );
    if (result?.ok) {
      setShowRoutineInput(false);
      setRoutineWhen("");
    }
  };

  return (
    <li className="rounded-xl bg-black/[0.035] px-3 py-2.5 dark:bg-white/[0.05]">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.8rem] font-medium">{workflow.name}</p>
          <p className="mt-0.5 text-[0.68rem] text-black/40 dark:text-white/45">
            {workflow.steps.length} {workflow.steps.length === 1 ? "step" : "steps"}
            {workflow.parameters.length ? ` · ${workflow.parameters.length} parameters` : ""}
          </p>
        </div>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => {
            if (workflow.parameters?.length) setShowRunInputs((value) => !value);
            else void run();
          }}
          className="rounded-lg bg-black/80 px-2.5 py-1 text-[0.68rem] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
        >
          Run
        </button>
      </div>
      {showRunInputs ? (
        <div className="mt-2 rounded-lg border border-black/[0.07] p-2 dark:border-white/10">
          <p className="text-[0.66rem] font-medium text-black/45 dark:text-white/45">
            Inputs for this run
          </p>
          <div className="mt-1.5 space-y-1.5">
            {workflow.parameters.map((parameter) => (
              <label
                key={parameter.name}
                className="flex items-center gap-2 text-[0.68rem] text-black/45 dark:text-white/50"
              >
                <span className="w-24 shrink-0 truncate" title={parameter.name}>
                  {parameter.name}
                  {parameter.required ? " *" : ""}
                </span>
                <input
                  value={runValues[parameter.name] ?? ""}
                  onChange={(event) =>
                    setRunValues((values) => ({
                      ...values,
                      [parameter.name]: event.target.value,
                    }))
                  }
                  className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2 py-1 text-[0.7rem] outline-none dark:border-white/10"
                />
              </label>
            ))}
          </div>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setShowRunInputs(false)}
              className="rounded-lg px-2 py-1 text-[0.68rem] text-black/40 dark:text-white/45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void run()}
              className="rounded-lg bg-black/80 px-2.5 py-1 text-[0.68rem] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Run workflow
            </button>
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        <button
          type="button"
          disabled={!!busy}
          onClick={onEdit}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[0.68rem] text-black/45 hover:bg-black/[0.05] dark:text-white/50 dark:hover:bg-white/[0.07]"
        >
          <Pencil className="h-3 w-3" /> Edit
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => setShowRoutineInput((value) => !value)}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[0.68rem] text-black/45 hover:bg-black/[0.05] dark:text-white/50 dark:hover:bg-white/[0.07]"
        >
          <Save className="h-3 w-3" /> Save as Routine
        </button>
        {workflow.recoveredUpdate?.id ? (
          <button
            type="button"
            disabled={!!busy}
            title={workflow.recoveredUpdate.summary || "Apply recovered targets"}
            onClick={() =>
              void act(
                "update recovered",
                () =>
                  applyRecoveredWorkflowUpdate(
                    workflow.id,
                    workflow.recoveredUpdate.id,
                  ),
                "Workflow updated from the successful recovery.",
              )
            }
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[0.68rem] text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
          >
            <Zap className="h-3 w-3" /> Update recovered path
          </button>
        ) : null}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => {
            if (!window.confirm(`Delete “${workflow.name}”?`)) return;
            void act(
              "delete",
              () => deleteWorkflow(workflow.id),
              "Workflow deleted.",
            );
          }}
          className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-[0.68rem] text-black/35 hover:bg-red-500/10 hover:text-red-500 dark:text-white/35"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </div>
      {showRoutineInput ? (
        <div className="mt-2 rounded-lg border border-black/[0.07] p-2 dark:border-white/10">
          <p className="text-[0.66rem] font-medium text-black/45 dark:text-white/45">
            When should it run?
          </p>
          <input
            value={routineWhen}
            onChange={(event) => setRoutineWhen(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveAsRoutine(false);
            }}
            placeholder="Every Monday at 8, or when a PDF appears in ~/Downloads"
            maxLength={300}
            className="mt-1.5 w-full rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-[0.7rem] outline-none placeholder:text-black/30 dark:border-white/10 dark:placeholder:text-white/30"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void saveAsRoutine(true)}
              className="rounded-lg px-2 py-1 text-[0.66rem] text-black/45 hover:bg-black/[0.05] dark:text-white/50 dark:hover:bg-white/[0.07]"
            >
              Manual only
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void saveAsRoutine(false)}
              className="rounded-lg bg-black/80 px-2.5 py-1 text-[0.66rem] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Create Routine
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function WorkflowEditor({ workflow, title, saving, onSave, onCancel }) {
  const [name, setName] = useState(workflow.name || "");
  const [objective, setObjective] = useState(workflow.objective || "");
  const [parameters, setParameters] = useState(() =>
    (workflow.parameters || []).map((parameter) => ({
      ...parameter,
      originalName: parameter.name,
      defaultText:
        parameter.default === undefined
          ? ""
          : typeof parameter.default === "string"
            ? parameter.default
            : JSON.stringify(parameter.default),
    })),
  );
  const [steps, setSteps] = useState(() => [...(workflow.steps || [])]);
  const [stepDraft, setStepDraft] = useState(null);
  const [error, setError] = useState("");

  const moveStep = (index, offset) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= steps.length) return;
    const next = [...steps];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setSteps(next);
  };

  const editStep = (step) => {
    setStepDraft({
      id: step.id,
      kind: step.kind,
      action: step.action || "",
      target: { ...(step.target || {}) },
    });
    setError("");
  };

  const applyStepEdit = () => {
    if (!stepDraft?.action.trim()) {
      setError("Every step needs an action.");
      return;
    }
    const target = Object.fromEntries(
      Object.entries(stepDraft.target || {}).filter(([, value]) => value !== ""),
    );
    if (
      stepDraft.kind === "browser" &&
      (target.role || target.name || target.url || target.href)
    ) {
      target.strategy = "semantic";
      target.confidence = "high";
      delete target.visual_anchor;
    }
    setSteps((items) =>
      items.map((step) =>
        step.id === stepDraft.id
          ? {
              ...step,
              action: stepDraft.action.trim(),
              target,
            }
          : step,
      ),
    );
    setStepDraft(null);
  };

  const removeParameter = (index) => {
    const parameter = parameters[index];
    if (!parameter) return;
    if (parameter.defaultText === "") {
      setError(`Add a default before removing ${parameter.name}, so its steps stay executable.`);
      return;
    }
    const replacement = String(parameter.defaultText);
    const from = String(parameter.originalName || parameter.name || "").toLowerCase();
    setSteps((items) => replaceWorkflowToken(items, from, replacement));
    setParameters((items) => items.filter((_, itemIndex) => itemIndex !== index));
    setError("");
  };

  const save = () => {
    if (!name.trim()) {
      setError("Give the workflow a name.");
      return;
    }
    if (!steps.length) {
      setError("Keep at least one workflow step.");
      return;
    }
    const seen = new Set();
    const cleanParameters = [];
    const renames = [];
    for (const parameter of parameters) {
      const parameterName = String(parameter.name || "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(parameterName) || seen.has(parameterName)) {
        setError("Parameter names must be unique lowercase names using letters, numbers, or underscores.");
        return;
      }
      seen.add(parameterName);
      const originalName = String(parameter.originalName || parameter.name || "").toLowerCase();
      if (originalName && originalName !== parameterName) {
        renames.push([originalName, parameterName]);
      }
      let defaultValue;
      if (parameter.defaultText !== "") {
        try {
          defaultValue = JSON.parse(parameter.defaultText);
        } catch {
          defaultValue = parameter.defaultText;
        }
      }
      cleanParameters.push({
        name: parameterName,
        ...(parameter.type ? { type: parameter.type } : {}),
        required: parameter.required !== false,
        ...(Array.isArray(parameter.paths) ? { paths: parameter.paths } : {}),
        ...(parameter.defaultText !== "" ? { default: defaultValue } : {}),
      });
    }
    let normalizedSteps = steps;
    for (const [from, to] of renames) {
      normalizedSteps = replaceWorkflowToken(normalizedSteps, from, `{{${to}}}`);
    }
    void onSave({
      ...workflow,
      botId: workflow.botId,
      name: name.trim(),
      objective: objective.trim(),
      parameters: cleanParameters,
      steps: normalizedSteps,
    });
  };

  return (
    <div className="mt-3 rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.025]">
      <p className="text-[0.72rem] font-semibold text-black/55 dark:text-white/60">{title}</p>
      <label className="mt-2 block text-[0.68rem] text-black/40 dark:text-white/40">
        Name
        <input
          value={name}
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
          className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-[0.78rem] text-black/80 outline-none focus:border-black/25 dark:border-white/10 dark:text-white/85 dark:focus:border-white/30"
        />
      </label>
      <label className="mt-2 block text-[0.68rem] text-black/40 dark:text-white/40">
        Goal and instructions
        <textarea
          value={objective}
          maxLength={1000}
          rows={2}
          onChange={(event) => {
            setObjective(event.target.value);
            setError("");
          }}
          className="mt-1 w-full resize-y rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-[0.72rem] text-black/80 outline-none focus:border-black/25 dark:border-white/10 dark:text-white/85 dark:focus:border-white/30"
        />
      </label>
      <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg bg-black/[0.025] p-2 text-[0.64rem] text-black/40 dark:bg-white/[0.035] dark:text-white/45">
        <div>
          <span className="font-medium text-black/50 dark:text-white/55">Capabilities</span>
          <p className="mt-0.5 break-words">
            {workflow.capabilities?.length ? workflow.capabilities.join(", ") : "None"}
          </p>
        </div>
        <div>
          <span className="font-medium text-black/50 dark:text-white/55">Connections</span>
          <p className="mt-0.5 break-words">
            {workflow.connections?.length
              ? workflow.connections.map((connection) => connection.id).join(", ")
              : "None"}
          </p>
        </div>
        <p>
          Human steps: {steps.filter((step) => step.human_takeover).length}
        </p>
        <p>
          Approval-gated: {steps.filter((step) => step.approvalRequired).length}
        </p>
        <p className="col-span-2">
          Low-confidence targets:{" "}
          {steps.filter((step) => step.target?.confidence === "low").length}
        </p>
      </div>

      {parameters.length ? (
        <div className="mt-3">
          <p className="text-[0.68rem] font-medium text-black/45 dark:text-white/45">Parameters</p>
          <div className="mt-1 space-y-1.5">
            {parameters.map((parameter, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input
                  aria-label={`Parameter ${index + 1} name`}
                  value={parameter.name}
                  onChange={(event) => {
                    const next = [...parameters];
                    next[index] = { ...parameter, name: event.target.value };
                    setParameters(next);
                    setError("");
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2 py-1 text-[0.7rem] outline-none dark:border-white/10"
                />
                <input
                  aria-label={`Parameter ${parameter.name} default`}
                  value={parameter.defaultText}
                  placeholder="Default"
                  onChange={(event) => {
                    const next = [...parameters];
                    next[index] = { ...parameter, defaultText: event.target.value };
                    setParameters(next);
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2 py-1 text-[0.7rem] outline-none placeholder:text-black/30 dark:border-white/10 dark:placeholder:text-white/30"
                />
                <label className="flex shrink-0 items-center gap-1 text-[0.65rem] text-black/40 dark:text-white/40">
                  <input
                    type="checkbox"
                    checked={parameter.required !== false}
                    onChange={(event) => {
                      const next = [...parameters];
                      next[index] = { ...parameter, required: event.target.checked };
                      setParameters(next);
                    }}
                  />
                  Required
                </label>
                <button
                  type="button"
                  title="Delete parameter"
                  onClick={() => removeParameter(index)}
                  className="rounded p-1 text-black/30 hover:text-red-500 dark:text-white/30"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3">
        <p className="text-[0.68rem] font-medium text-black/45 dark:text-white/45">Steps</p>
        <ol className="mt-1 space-y-1">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className="flex items-center gap-1.5 rounded-lg bg-black/[0.035] px-2 py-1.5 dark:bg-white/[0.05]"
            >
              <span className="w-4 shrink-0 text-[0.65rem] text-black/30 dark:text-white/30">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[0.7rem]" title={workflowStepLabel(step)}>
                {workflowStepLabel(step)}
              </span>
              <button
                type="button"
                title="Edit action and target"
                onClick={() => editStep(step)}
                className="rounded p-1 text-black/30 hover:bg-black/[0.05] hover:text-black/60 dark:text-white/30 dark:hover:bg-white/[0.07] dark:hover:text-white/65"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="Move up"
                disabled={index === 0}
                onClick={() => moveStep(index, -1)}
                className="rounded p-1 text-black/35 hover:bg-black/[0.05] disabled:opacity-20 dark:text-white/35"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="Move down"
                disabled={index === steps.length - 1}
                onClick={() => moveStep(index, 1)}
                className="rounded p-1 text-black/35 hover:bg-black/[0.05] disabled:opacity-20 dark:text-white/35"
              >
                <ArrowDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="Delete step"
                disabled={steps.length === 1}
                onClick={() => setSteps(steps.filter((_, itemIndex) => itemIndex !== index))}
                className="rounded p-1 text-black/30 hover:text-red-500 disabled:opacity-20 dark:text-white/30"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ol>
        {stepDraft ? (
          <div className="mt-2 rounded-lg border border-black/[0.07] p-2 dark:border-white/10">
            <label className="block text-[0.66rem] text-black/40 dark:text-white/45">
              Action / method
              <input
                value={stepDraft.action}
                onChange={(event) =>
                  setStepDraft((draft) => ({ ...draft, action: event.target.value }))
                }
                className="mt-1 w-full rounded-lg border border-black/10 bg-transparent px-2 py-1 text-[0.7rem] outline-none dark:border-white/10"
              />
            </label>
            <div className="mt-2">
              <p className="text-[0.66rem] text-black/40 dark:text-white/45">Durable target</p>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                {workflowTargetFields(stepDraft.kind).map(({ key, label }) => (
                  <label
                    key={key}
                    className="text-[0.62rem] text-black/35 dark:text-white/40"
                  >
                    {label}
                    <input
                      value={stepDraft.target?.[key] || ""}
                      onChange={(event) =>
                        setStepDraft((draft) => ({
                          ...draft,
                          target: { ...draft.target, [key]: event.target.value },
                        }))
                      }
                      className="mt-0.5 w-full rounded-lg border border-black/10 bg-transparent px-2 py-1 text-[0.68rem] text-black/75 outline-none dark:border-white/10 dark:text-white/80"
                    />
                  </label>
                ))}
              </div>
              {stepDraft.target?.confidence === "low" ? (
                <p className="mt-1 text-[0.62rem] text-amber-600 dark:text-amber-400">
                  This target used a low-confidence visual fallback. Add a role and name when possible.
                </p>
              ) : null}
            </div>
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setStepDraft(null)}
                className="rounded-lg px-2 py-1 text-[0.66rem] text-black/40 dark:text-white/45"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyStepEdit}
                className="rounded-lg bg-black/80 px-2.5 py-1 text-[0.66rem] font-semibold text-white dark:bg-white dark:text-black"
              >
                Apply step
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-[0.68rem] text-red-500">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="rounded-lg px-2.5 py-1.5 text-[0.7rem] text-black/45 hover:bg-black/[0.05] dark:text-white/50 dark:hover:bg-white/[0.07]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="rounded-lg bg-black/85 px-3 py-1.5 text-[0.7rem] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
        >
          {saving ? "Saving…" : "Save workflow"}
        </button>
      </div>
    </div>
  );
}

function replaceWorkflowToken(value, parameterName, replacement) {
  if (typeof value === "string") {
    return value.split(`{{${parameterName}}}`).join(replacement);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceWorkflowToken(item, parameterName, replacement));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceWorkflowToken(item, parameterName, replacement),
      ]),
    );
  }
  return value;
}

function workflowTargetFields(kind) {
  if (kind === "browser") {
    return [
      { key: "role", label: "Role" },
      { key: "name", label: "Accessible name" },
      { key: "url", label: "URL" },
      { key: "href", label: "Link" },
    ];
  }
  if (kind === "local") {
    return [
      { key: "path", label: "File or folder" },
      { key: "app", label: "Application" },
      { key: "role", label: "Control role" },
      { key: "name", label: "Control name" },
    ];
  }
  if (kind === "mcp") {
    return [
      { key: "connectionId", label: "Connection" },
      { key: "toolName", label: "Tool" },
    ];
  }
  if (kind === "remote") {
    return [{ key: "remoteTargetId", label: "Remote target" }];
  }
  return [];
}

function workflowStepLabel(step) {
  const target =
    step.target?.name ||
    step.target?.label ||
    step.target?.ariaLabel ||
    step.target?.text ||
    step.target?.toolName ||
    step.target?.path ||
    step.target?.app ||
    "";
  return `${step.kind} · ${step.action}${target ? ` · ${target}` : ""}`;
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
