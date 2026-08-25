import { questionChips, questionPrompt, SKIP_ANSWER } from "@/lib/agentQuestions";

export type AgentQuestionButton = {
  id: string;
  label: string;
  primary?: boolean;
};

type AgentQuestionCardProps = {
  question: string;
  options?: string[];
  buttons?: AgentQuestionButton[];
  onAnswer: (text: string) => void;
  onButton?: (id: string) => void;
  disabled?: boolean;
};

/**
 * Liquid-glass question card above the regular chat bar.
 * Same material as HomeChatBar (`lg-desktop-surface`). Type in the bar.
 */
export default function AgentQuestionCard({
  question,
  options = [],
  buttons = [],
  onAnswer,
  onButton,
  disabled = false,
}: AgentQuestionCardProps) {
  const prompt = questionPrompt(question);
  const chips = questionChips(options);

  if (!prompt && !buttons.length) return null;

  return (
    <div
      className="lg-desktop-surface relative rounded-[18px] px-3.5 py-3"
      data-agent-question-card
    >
      {prompt ? (
        <p className="text-[0.88rem] font-medium leading-snug tracking-[-0.015em]">
          {prompt}
        </p>
      ) : null}

      {chips.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={disabled}
              onClick={() => onAnswer(chip)}
              className="max-w-full rounded-full px-2.5 py-1 text-left text-[0.72rem] leading-snug text-black/70 transition-colors hover:bg-black/[0.06] disabled:opacity-40 dark:text-white/80 dark:hover:bg-white/[0.10]"
            >
              <span className="line-clamp-2">{chip}</span>
            </button>
          ))}
        </div>
      ) : null}

      {buttons.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={disabled}
              onClick={() => onButton?.(b.id)}
              className={`rounded-full px-3 py-1 text-[0.72rem] font-medium transition-colors disabled:opacity-40 ${
                b.primary
                  ? "bg-black/85 text-white hover:bg-black dark:bg-white dark:text-black dark:hover:bg-white/90"
                  : "text-black/70 hover:bg-black/[0.06] dark:text-white/80 dark:hover:bg-white/[0.10]"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
      ) : null}

      {!buttons.length ? (
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(SKIP_ANSWER)}
            className="rounded-md px-1 py-0.5 text-[11px] text-black/35 transition-colors hover:text-black/55 disabled:opacity-40 dark:text-white/35 dark:hover:text-white/55"
          >
            Skip
          </button>
        </div>
      ) : null}
    </div>
  );
}
