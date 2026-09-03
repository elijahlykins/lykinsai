// /bots/:botId — one Bot's page: identity, connections, and custom skills.
// Conversation still happens in regular chat via the Bot menu; this page is
// where you shape how it works. Teach-a-task and Routines stay behind
// botStandingWorkUiEnabled until that feature launches.
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Circle, X } from "lucide-react";
import BotAvatar, { botMood, botPresence } from "@/components/bots/BotAvatar";
import BotSkillsPanel from "@/components/bots/BotSkillsPanel";
import {
  BotConnections,
  BotRoutines,
  BotWorkflows,
} from "@/components/bots/BotsPage";
import { botStandingWorkUiEnabled } from "@/lib/bots/botStandingWorkUi";
import { botSeed } from "@/lib/bots/botStore";
import { botsAvailable, removeBot, setBotModelPolicy, useBots } from "@/lib/bots/botsClient";
import { routinesAvailable } from "@/lib/routines/routinesClient";
import { useTeachSession, workflowsAvailable } from "@/lib/workflows/workflowsClient";

export default function BotDetailPage() {
  const { botId } = useParams();
  const navigate = useNavigate();
  const desktop = botsAvailable();
  const { bots, agentStates, live } = useBots();
  const teaching = useTeachSession();
  const bot = bots.find((b) => b.id === botId) || null;
  const teachingThisBot = teaching.active && teaching.session?.botId === bot?.id;

  useEffect(() => {
    if (desktop && bots.length > 0 && !bot) navigate("/bots", { replace: true });
  }, [desktop, bots.length, bot, navigate]);

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

  if (!bot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-black/60 dark:text-white/60">This Bot is gone.</p>
        <button
          type="button"
          onClick={() => navigate("/bots")}
          className="inline-flex items-center gap-1.5 text-xs text-black/50 transition-colors hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All bots
        </button>
      </div>
    );
  }

  const agent = agentStates[bot.agentId];
  const liveState = live[bot.agentId];
  const presence = botPresence(bot, agent, liveState);

  return (
    <div className="relative h-full min-h-0 overflow-y-auto text-black/80 dark:text-white/85">
      <div className="mx-auto max-w-md px-6 pb-10 pt-4">
        <button
          type="button"
          onClick={() => navigate("/bots")}
          className="inline-flex items-center gap-1.5 text-xs text-black/45 transition-colors hover:text-black/75 dark:text-white/45 dark:hover:text-white/80"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All bots
        </button>

        <div className="mt-4 flex items-start gap-3">
          <BotAvatar
            face={bot.face}
            eyes={bot.eyes}
            color={bot.color}
            size={56}
            mood={botMood(bot, agent, liveState)}
            seed={botSeed(bot.id)}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <h1 className="min-w-0 truncate text-xl font-semibold tracking-[-0.02em]">
                {bot.name}
              </h1>
              <button
                type="button"
                title={`Dismiss ${bot.name}`}
                disabled={teachingThisBot}
                onClick={() => {
                  if (teachingThisBot) return;
                  removeBot(bot.id);
                  navigate("/bots");
                }}
                className="ml-auto rounded-full p-1 text-black/30 transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40 dark:text-white/30"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-0.5 truncate text-[0.72rem] text-black/45 dark:text-white/45">
              {presence.label}
            </p>
            {bot.role ? (
              <p className="mt-0.5 truncate text-[0.72rem] text-black/40 dark:text-white/40">
                {bot.role}
              </p>
            ) : null}
          </div>
        </div>

        <label className="mt-4 block">
          <span className="text-[0.72rem] text-black/45 dark:text-white/45">Model</span>
          <select
            className="mt-1 h-8 w-full rounded-[10px] bg-black/[0.04] px-2.5 text-[13px] dark:bg-white/[0.06]"
            value={bot.modelPolicy?.mode || "lykn"}
            onChange={(e) => {
              const mode = e.target.value;
              setBotModelPolicy(bot.id, {
                mode,
                modelId: mode === "model" ? bot.modelPolicy?.modelId || null : null,
              });
            }}
          >
            <option value="lykn">LYKN</option>
            <option value="my_setup">My Setup</option>
          </select>
        </label>

        {bot.persona ? (
          <p className="mt-3 text-[0.78rem] leading-relaxed text-black/50 dark:text-white/50">
            {bot.persona}
          </p>
        ) : (
          <p className="mt-3 text-[0.72rem] text-black/40 dark:text-white/40">
            Message {bot.name} from the Bot menu next to the chat bar.
          </p>
        )}

        {botStandingWorkUiEnabled() && teachingThisBot ? (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2">
            <Circle className="h-2.5 w-2.5 fill-red-500 text-red-500" />
            <p className="min-w-0 flex-1 truncate text-[0.72rem] font-medium">
              Teaching {bot.name}
              <span className="font-normal text-black/45 dark:text-white/45">
                {" "}
                · {teaching.session?.eventCount || 0} actions
              </span>
            </p>
          </div>
        ) : null}

        <div className="mt-6 space-y-6">
          <BotConnections bot={bot} />
          <BotSkillsPanel bot={bot} />
          {botStandingWorkUiEnabled() && workflowsAvailable() ? <BotWorkflows bot={bot} /> : null}
          {botStandingWorkUiEnabled() && routinesAvailable() ? <BotRoutines bot={bot} /> : null}
        </div>
      </div>
    </div>
  );
}
