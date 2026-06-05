import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import ModelBuilderChatToolsSection from "@/components/modelBuilder/ModelBuilderChatToolsSection";

export default function ModelBuilderStagePromptTools({
  draft,
  patch,
  errors = [],
  resolvedPrompt,
  showHeader = true,
}) {
  return (
    <div className={showHeader ? "mx-auto w-full max-w-lg space-y-6 py-2" : "space-y-5"}>
      {showHeader ? (
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight">System prompt & tools</h2>
          <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
            Define how your model behaves and which tools it can use in chat.
          </p>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <ul
          className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 text-[12px] text-amber-900 dark:text-amber-200 space-y-1"
          role="alert"
        >
          {errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      ) : null}

      <section className="space-y-2">
        <div>
          <Label htmlFor="model-system-prompt" className="text-[12px]">
            System prompt
          </Label>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            Persona, boundaries, and behavior. Use{" "}
            <code className="text-[11px]">{"{{model_name}}"}</code>. We substitute your model name automatically.
            Basics (name, tone, length) sync into{" "}
            <code className="text-[11px]">## Identity</code> and{" "}
            <code className="text-[11px]">## Response style</code> when you save.
          </p>
        </div>
        <Textarea
          id="model-system-prompt"
          value={draft.systemPrompt || ""}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
          rows={14}
          className="font-mono text-[11.5px] leading-relaxed min-h-[220px] resize-y"
        />
        <p className="text-[10px] text-muted-foreground">{resolvedPrompt.length} characters deployed</p>
      </section>

      <ModelBuilderChatToolsSection draft={draft} patch={patch} />
    </div>
  );
}
