import { useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import ModelBuilderModelEngineSelect from "@/components/modelBuilder/ModelBuilderModelEngineSelect";
import { TRAINING_MODES } from "@/lib/modelBuilder/draftDefaults";
import {
  MODEL_ENGINE_CLOSED,
  MODEL_ENGINE_OPEN,
  modelEngineFromDraft,
} from "@/lib/modelBuilder/modelEngine";
import {
  RESPONSE_LENGTH_OPTIONS,
} from "@/lib/modelBuilder/modelBehaviorSettings";
import { mergeModelBuilderIntoSystemPrompt } from "@/lib/modelBuilder/syncSystemPromptBasics";
import ModelBuilderOrchestrationSection from "@/components/modelBuilder/ModelBuilderOrchestrationSection";

const choiceButtonClass = (selected) =>
  cn(
    "text-left rounded-xl border px-3.5 py-3 transition-colors",
    selected
      ? "border-blue-400/50 bg-blue-500/10"
      : "border-black/8 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
  );

const compactChoiceClass = (selected, accent = "blue") =>
  cn(
    "text-left rounded-xl border px-3.5 py-2.5 transition-colors",
    selected
      ? accent === "green"
        ? "border-green-500/40 bg-green-500/10"
        : "border-blue-400/50 bg-blue-500/10"
      : "border-black/8 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
  );

export default function ModelBuilderBasicsForm({
  draft,
  patch,
  errors = [],
  syncPrompt = true,
  showTrainingSection = false,
  showOrchestrationSection = false,
  otherModels = [],
  nameInputId = "model-name",
  descriptionInputId = "model-description",
}) {
  const engine = modelEngineFromDraft(draft);
  const loraOnlyOpenSource = showTrainingSection && draft.trainingMode === "lora";

  useEffect(() => {
    if (!syncPrompt) return;
    const next = mergeModelBuilderIntoSystemPrompt(draft.systemPrompt, draft);
    if (next !== draft.systemPrompt) {
      patch({ systemPrompt: next });
    }
  }, [draft.name, draft.description, draft.responseLength, draft.responseTone]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-5">
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

      <div className="space-y-2">
        <Label htmlFor={nameInputId} className="text-[12px]">
          Model name
        </Label>
        <Input
          id={nameInputId}
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="e.g. Research assistant"
          className="h-10 text-[14px] font-medium"
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={descriptionInputId} className="text-[12px]">
          Short description{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id={descriptionInputId}
          value={draft.description || ""}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="What is this model for? One or two sentences."
          rows={3}
          className="text-[13px] leading-relaxed resize-none"
        />
      </div>

      <ModelBuilderModelEngineSelect
        draft={draft}
        patch={patch}
        loraOnlyOpenSource={loraOnlyOpenSource}
        triggerId={`${nameInputId}-engine`}
      />

      {showOrchestrationSection ? (
        <ModelBuilderOrchestrationSection
          draft={draft}
          patch={patch}
          otherModels={otherModels}
        />
      ) : null}

      <div className="space-y-3">
        <div>
          <Label className="text-[12px]">Response length</Label>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            How long answers should be in chat. Synced into your system prompt automatically.
          </p>
        </div>
        <div className="grid gap-2">
          {RESPONSE_LENGTH_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => patch({ responseLength: opt.id })}
              className={choiceButtonClass(draft.responseLength === opt.id)}
            >
              <span className="text-[13px] font-semibold block">{opt.label}</span>
              <span className="text-[11px] text-muted-foreground">{opt.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${nameInputId}-tone`} className="text-[12px]">
          Tone
        </Label>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Describe how this model should sound. Synced into your system prompt automatically.
        </p>
        <Textarea
          id={`${nameInputId}-tone`}
          value={draft.responseTone || ""}
          onChange={(e) => patch({ responseTone: e.target.value })}
          placeholder="e.g. Warm and direct, like a thoughtful colleague. Use plain language and avoid jargon unless the user does."
          rows={3}
          className="text-[13px] leading-relaxed resize-none"
        />
      </div>

      {showTrainingSection ? (
        <>
          <div className="space-y-2">
            <Label className="text-[12px]">How should this model learn?</Label>
            <div className="grid gap-2">
              {TRAINING_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  disabled={engine === MODEL_ENGINE_CLOSED && mode.id === "lora"}
                  onClick={() =>
                    patch({
                      trainingMode: mode.id,
                      ...(mode.id === "lora"
                        ? {
                            baseKind: "open_source",
                            placedBlocks: uniquePlaced(draft.placedBlocks, "training"),
                            openSourceModelId: "qwen3-8b-lora",
                          }
                        : {}),
                    })
                  }
                  className={cn(
                    compactChoiceClass(draft.trainingMode === mode.id, "green"),
                    engine === MODEL_ENGINE_CLOSED &&
                      mode.id === "lora" &&
                      "opacity-45 cursor-not-allowed",
                  )}
                >
                  <span className="text-[13px] font-semibold block">{mode.label}</span>
                  <span className="text-[11px] text-muted-foreground">{mode.hint}</span>
                </button>
              ))}
            </div>
            {engine === MODEL_ENGINE_CLOSED ? (
              <p className="text-[11px] text-muted-foreground">
                LoRA requires an open-source base. Switch engine or use prompt-only on a closed model.
              </p>
            ) : null}
          </div>

          {engine === MODEL_ENGINE_OPEN && draft.trainingMode === "lora" ? (
            <p className="text-[11px] text-muted-foreground -mt-2">
              LoRA uses Qwen3 8B on Together, configured when you start training.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function uniquePlaced(placed, id) {
  const list = placed || [];
  return list.includes(id) ? list : [...list, id];
}
