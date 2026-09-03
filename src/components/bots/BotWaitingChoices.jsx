// One-tap answers when a Bot is parked on a real question (not an approval).
// Renders in the chat thread only.
import AgentQuestionCard from "@/components/lyknChat/AgentQuestionCard";
import { questionChips, questionPrompt } from "@/lib/agentQuestions";
import { getBots, useBots } from "@/lib/bots/botsClient";
import { parseAskTeammate } from "@/lib/bots/botStore";

const APPROVAL_TYPES = new Set(["local-approval", "browse-approval"]);

function sendBotAnswer(botId, answer) {
  const text = String(answer || "").trim();
  if (!botId || !text) return;
  const payload = { view: "", text, botId };
  try {
    sessionStorage.setItem("lykn_pending_home_chat", JSON.stringify(payload));
  } catch {
    /* the event below still covers a warm chat surface */
  }
  window.dispatchEvent(new CustomEvent("lykn-home-chat-send", { detail: payload }));
}

function parkedQuestion(bot, live, agentStates) {
  if (!bot?.agentId) return null;
  const liveWait = live[bot.agentId]?.waiting;
  const choice = live[bot.agentId]?.choice;
  const agent = agentStates[bot.agentId] || {};
  if (choice?.buttons?.length && APPROVAL_TYPES.has(String(choice.type || ""))) {
    return null;
  }
  const kind = String(liveWait?.kind || agent.waitingKind || "");
  if (kind && kind !== "question") return null;
  const parked = !!(liveWait?.waiting || (agent.waiting && kind === "question"));
  if (!parked) return null;
  const rawQuestion = liveWait?.detail || liveWait?.label || agent.waitingDetail || "";
  if (parseAskTeammate(rawQuestion)) return null;
  const question = questionPrompt(rawQuestion);
  const options = questionChips(liveWait?.options || agent.waitingOptions || []);
  if (!question && !options.length) return null;
  return { bot, question, options };
}

export default function BotWaitingChoices({ botId = "" }) {
  const { bots, agentStates, live } = useBots();
  const roster = bots.length ? bots : getBots();
  const bot = botId ? roster.find((b) => b.id === botId) : null;
  const parked = parkedQuestion(bot, live, agentStates);

  if (!parked) return null;

  return (
    <AgentQuestionCard
      question={parked.question}
      options={parked.options}
      onAnswer={(answer) => sendBotAnswer(parked.bot.id, answer)}
    />
  );
}
