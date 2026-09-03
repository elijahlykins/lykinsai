import { useEffect } from "react";
import { requestLocalApproval } from "@/lib/ai/localToolApproval";
import { answerChoice, getBots, subscribeBots, useBots } from "@/lib/bots/botsClient";

const APPROVAL_TYPES = new Set(["local-approval", "browse-approval"]);
const g = globalThis as typeof globalThis & { __lyknBotApprovalSeen?: Set<string> };
const seenChoiceIds = (g.__lyknBotApprovalSeen ||= new Set<string>());

function approvalTool(choice: { type?: string; tool?: string }): string {
  const tool = String(choice?.tool || "").trim();
  if (tool) return tool;
  return String(choice?.type || "") === "browse-approval" ? "browser" : "local_write_file";
}

/**
 * Parked bot approvals use LYKN's LocalToolApprovalCard, not the question card.
 * One request per choiceId; Approve/Decline resolves the runtime choice.
 */
export function useBotLocalApprovals(): void {
  const { bots, live } = useBots();

  useEffect(() => {
    const roster = bots.length ? bots : getBots();
    for (const bot of roster) {
      const choice = live[bot.agentId]?.choice;
      const type = String(choice?.type || "");
      const choiceId = String(choice?.choiceId || "");
      if (!choice || !choiceId || !APPROVAL_TYPES.has(type) || seenChoiceIds.has(choiceId)) {
        continue;
      }
      seenChoiceIds.add(choiceId);
      void requestLocalApproval({
        tool: approvalTool(choice),
        summary: String(choice.message || "Allow this action?"),
        args: {},
      }).then((approved) => {
        answerChoice(bot.id, choice, approved ? "approve" : "decline");
      });
    }
  }, [bots, live]);

  useEffect(() => subscribeBots(() => {}), []);
}
