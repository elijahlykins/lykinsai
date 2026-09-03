import { questionChips, SKIP_ANSWER, splitQuestion } from "@/lib/agentQuestions";

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

function ChipLabel({ text }: { text: string }) {
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        const bold = part.startsWith("**") && part.endsWith("**");
        const inner = bold ? part.slice(2, -2) : part;
        return bold ? <strong key={i}>{inner}</strong> : <span key={i}>{inner}</span>;
      })}
    </>
  );
}

/**
 * Question card in the chat thread. Approvals use LocalToolApprovalCard.
 */
export default function AgentQuestionCard({
  question,
  options = [],
  buttons = [],
  onAnswer,
  onButton,
  disabled = false,
}: AgentQuestionCardProps) {
  const { title, body } = splitQuestion(question);
  const chips = questionChips(options);

  if (!title && !body && !buttons.length && !chips.length) return null;

  return (
    <div
      className="relative rounded-2xl border border-black/10 bg-black/[0.03] px-4 py-3 dark:border-white/12 dark:bg-white/[0.05]"
      data-agent-question-card
    >
      <div className="text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-black/40 dark:text-white/40">
        Question
      </div>
      {title ? (
        <h3 className="mt-1 text-[0.95rem] font-semibold leading-snug tracking-[-0.02em] text-black/90 dark:text-white/90">
          {title}
        </h3>
      ) : null}
      {body ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[0.82rem] font-medium leading-snug text-black/70 dark:text-white/70">
          {body}
        </p>
      ) : null}

      {chips.length > 0 ? (
        <div className="mt-3 flex min-w-0 flex-col gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={disabled}
              onClick={() => onAnswer(chip)}
              className="w-full shrink-0 rounded-xl bg-black/[0.05] px-3 py-2 text-left text-[0.78rem] font-medium leading-snug text-black/80 transition-colors hover:bg-black/[0.09] disabled:opacity-40 dark:bg-white/[0.08] dark:text-white/85 dark:hover:bg-white/[0.14]"
            >
              <ChipLabel text={chip} />
            </button>
          ))}
        </div>
      ) : null}

      {buttons.length > 0 ? (
        <div className="mt-3 flex min-w-0 flex-col gap-1.5">
          {buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={disabled}
              onClick={() => onButton?.(b.id)}
              className={`w-full shrink-0 rounded-xl px-3 py-2 text-left text-[0.78rem] font-medium leading-snug transition-colors disabled:opacity-40 ${
                b.primary
                  ? "bg-black/85 text-white hover:bg-black dark:bg-white dark:text-black dark:hover:bg-white/90"
                  : "bg-black/[0.05] text-black/80 hover:bg-black/[0.09] dark:bg-white/[0.08] dark:text-white/85 dark:hover:bg-white/[0.14]"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
      ) : null}

      {!buttons.length ? (
        <div className="mt-2 flex justify-end">
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
