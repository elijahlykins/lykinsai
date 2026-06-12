import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  Upload,
} from "lucide-react";
import ModelBuilderHome from "@/components/modelBuilder/ModelBuilderHome";
import ModelBuilderSelectModelDialog from "@/components/modelBuilder/ModelBuilderSelectModelDialog";
import ModelBuilderNewModelDialog from "@/components/modelBuilder/ModelBuilderNewModelDialog";
import ModelBuilderPromptToolsDialog from "@/components/modelBuilder/ModelBuilderPromptToolsDialog";
import ModelBuilderKnowledgeDialog from "@/components/modelBuilder/ModelBuilderKnowledgeDialog";
import ModelBuilderSummaryDialog from "@/components/modelBuilder/ModelBuilderSummaryDialog";
import ModelBuilderStepNav from "@/components/modelBuilder/ModelBuilderStepNav";
import ModelBuilderStageBasics from "@/components/modelBuilder/ModelBuilderStageBasics";
import ModelBuilderStagePublish from "@/components/modelBuilder/ModelBuilderStagePublish";
import {
  BUILDER_STEP_STORAGE_KEY,
  MODEL_BUILDER_STAGES,
  loadBuilderStep,
  saveBuilderStep,
  validateBasicsStep,
  validatePromptStep,
  validateKnowledgeStep,
} from "@/lib/modelBuilder/builderStages";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import ModelBuilderStageKnowledge from "@/components/modelBuilder/ModelBuilderStageKnowledge";
import ModelBuilderStagePromptTools from "@/components/modelBuilder/ModelBuilderStagePromptTools";
import {
  computeBuilderProgress,
  emptyModelDraft,
  DEMO_SYSTEM_PROMPT_STARTER,
  TRAINING_MODES,
} from "@/lib/modelBuilder/draftDefaults";
import { normalizeModelBehavior } from "@/lib/modelBuilder/modelBehaviorSettings";
import {
  mergeModelBuilderIntoSystemPrompt,
  resolveSystemPromptForDraft,
} from "@/lib/modelBuilder/syncSystemPromptBasics";
import { useAuth } from "@/lib/SupabaseAuth";
import { toast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import {
  apiModelToDraft,
  deleteCustomModel,
  fetchCustomModels,
  publishCustomModel,
  saveCustomModelDraft,
} from "@/lib/modelBuilder/customModelsClient";
import {
  loadActiveCustomModelId,
  saveActiveCustomModelId,
} from "@/lib/modelBuilder/activeCustomModelStorage";
import {
  downloadTrainingSetFile,
  fetchLatestTrainingSetJob,
  fetchTrainingSetJob,
  fetchTrainingSourcesPreview,
  pollTrainingSetJob,
  startTrainingSetGeneration,
  trainingKnowledgeFromDraft,
  formatTrainingJobStamp,
  formatTrainingSourceSummary,
  trainingJobLabel,
  trainingJobProgress,
} from "@/lib/training/trainingSetClient";
import {
  fetchLatestLoraJob,
  fetchLoraConfig,
  loraJobLabel,
  loraJobProgress,
  pollLoraJob,
  startLoraTraining,
} from "@/lib/modelBuilder/loraClient";
import ModelBuilderWalletCard from "@/components/modelBuilder/ModelBuilderWalletCard";

const STORAGE_KEY = "lykn_model_builder_draft_v1";

const TRAIN_STEP_INDEX = MODEL_BUILDER_STAGES.findIndex((s) => s.id === "train");

export default function ModelBuilder({ wakePreview = false } = {}) {
  const { user } = useAuth();
  const [view, setView] = useState("home");
  const [draft, setDraft] = useState(emptyModelDraft);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectModelDialogOpen, setSelectModelDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [knowledgeDialogOpen, setKnowledgeDialogOpen] = useState(false);
  const [summaryDialogOpen, setSummaryDialogOpen] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createSaved, setCreateSaved] = useState(false);
  const createSavedRef = useRef(false);
  const [createDraft, setCreateDraft] = useState(emptyModelDraft);
  const [createErrors, setCreateErrors] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [modelLoadDone, setModelLoadDone] = useState(true);
  const [trainingJob, setTrainingJob] = useState(null);
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [trainingSim, setTrainingSim] = useState(null);
  const [trainingOptOut, setTrainingOptOut] = useState(false);
  const [chatExchangeCount, setChatExchangeCount] = useState(null);
  const [loraJob, setLoraJob] = useState(null);
  const [loraBusy, setLoraBusy] = useState(false);
  const [loraSim, setLoraSim] = useState(null);
  const [loraConfigured, setLoraConfigured] = useState(false);
  const [stepIndex, setStepIndex] = useState(loadBuilderStep);
  const [maxReachable, setMaxReachable] = useState(loadBuilderStep);
  const [basicsErrors, setBasicsErrors] = useState([]);
  const [promptErrors, setPromptErrors] = useState([]);
  const [createKnowledgeErrors, setCreateKnowledgeErrors] = useState([]);
  const [knowledgeErrors, setKnowledgeErrors] = useState([]);

  const progress = useMemo(() => computeBuilderProgress(draft), [draft]);
  const createResolvedPrompt = useMemo(
    () => resolveSystemPromptForDraft(createDraft),
    [createDraft],
  );
  const canPublish = useMemo(() => {
    const name = (draft.name || "").trim();
    return (
      Boolean(user?.id) &&
      name.length > 0 &&
      !/^untitled model$/i.test(name) &&
      (draft.systemPrompt || "").trim().length >= 20
    );
  }, [draft.name, draft.systemPrompt, user?.id]);

  useEffect(() => {
    if (view !== "builder") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [draft, view]);

  useEffect(() => {
    saveBuilderStep(stepIndex);
  }, [stepIndex]);

  const goToStep = useCallback((index) => {
    const i = Math.max(0, Math.min(index, MODEL_BUILDER_STAGES.length - 1));
    setStepIndex(i);
  }, []);

  const handleBack = useCallback(() => {
    if (stepIndex > 0) goToStep(stepIndex - 1);
  }, [stepIndex, goToStep]);

  const currentStageId = MODEL_BUILDER_STAGES[stepIndex]?.id;

  const handleContinue = useCallback(() => {
    if (currentStageId === "basics") {
      const v = validateBasicsStep(draft);
      if (!v.ok) {
        setBasicsErrors(v.errors);
        return;
      }
      setBasicsErrors([]);
    }
    if (currentStageId === "prompt") {
      const v = validatePromptStep(draft);
      if (!v.ok) {
        setPromptErrors(v.errors);
        return;
      }
      setPromptErrors([]);
    }
    if (currentStageId === "configure") {
      const v = validateKnowledgeStep(draft);
      if (!v.ok) {
        setKnowledgeErrors(v.errors);
        return;
      }
      setKnowledgeErrors([]);
    }
    const next = Math.min(stepIndex + 1, MODEL_BUILDER_STAGES.length - 1);
    setMaxReachable((m) => Math.max(m, next));
    goToStep(next);
  }, [currentStageId, stepIndex, draft, goToStep]);

  const showStepContinue = stepIndex < MODEL_BUILDER_STAGES.length - 1;

  const stepContinueBar = showStepContinue ? (
    <div className="shrink-0 px-4 sm:px-6 pb-10 pt-2">
      <div className="mx-auto w-full max-w-lg flex items-center gap-3">
        {stepIndex > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={handleBack} className="-ml-2 shrink-0">
            <ChevronLeft className="h-4 w-4" />
            Back
          </Button>
        ) : null}
        <div className="min-w-0 flex-1" aria-hidden />
        <button type="button" className="lykn-primary-btn shrink-0" onClick={handleContinue}>
          Continue
          <ChevronRight className="h-4 w-4" strokeWidth={2.25} />
        </button>
      </div>
    </div>
  ) : null;

  const refreshModels = useCallback(async () => {
    if (!user?.id) return;
    try {
      const list = await fetchCustomModels();
      setModels(list);
    } catch {
      setModels([]);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    fetchCustomModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const enterBuilder = useCallback((nextDraft, { initialStep = 0 } = {}) => {
    const merged = {
      ...emptyModelDraft(),
      ...nextDraft,
      ...normalizeModelBehavior(nextDraft),
      updatedAt: nextDraft.updatedAt || new Date().toISOString(),
    };
    setDraft(merged);
    setBasicsErrors([]);
    setPromptErrors([]);
    setKnowledgeErrors([]);
    const step = Math.max(0, Math.min(initialStep, MODEL_BUILDER_STAGES.length - 1));
    setStepIndex(step);
    setMaxReachable(step);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      localStorage.setItem(BUILDER_STEP_STORAGE_KEY, String(step));
    } catch {
      /* ignore */
    }
    setView("builder");
  }, []);

  const patchCreateDraft = useCallback((partial) => {
    setCreateDraft((d) => ({ ...d, ...partial, updatedAt: new Date().toISOString() }));
  }, []);

  const handleCreateModel = useCallback(() => {
    setSelectModelDialogOpen(false);
    setCreateErrors([]);
    setPromptErrors([]);
    setCreateKnowledgeErrors([]);
    setCreateDraft(
      wakePreview
        ? { ...emptyModelDraft(), systemPrompt: DEMO_SYSTEM_PROMPT_STARTER }
        : emptyModelDraft(),
    );
    setPromptDialogOpen(false);
    setKnowledgeDialogOpen(false);
    setSummaryDialogOpen(false);
    setCreateSaved(false);
    createSavedRef.current = false;
    setCreateSaving(false);
    setCreateDialogOpen(true);
  }, [wakePreview]);

  const handleCreateDialogContinue = useCallback(() => {
    const v = validateBasicsStep(createDraft);
    if (!v.ok) {
      setCreateErrors(v.errors);
      return;
    }
    setCreateErrors([]);
    setCreateDialogOpen(false);
    setCreateDraft((d) => ({
      ...d,
      systemPrompt: mergeModelBuilderIntoSystemPrompt(d.systemPrompt, d),
    }));
    setPromptErrors([]);
    setPromptDialogOpen(true);
  }, [createDraft]);

  const handlePromptDialogBack = useCallback(() => {
    setPromptDialogOpen(false);
    setPromptErrors([]);
    setCreateDialogOpen(true);
  }, []);

  const handlePromptDialogContinue = useCallback(() => {
    const v = validatePromptStep(createDraft);
    if (!v.ok) {
      setPromptErrors(v.errors);
      return;
    }
    setPromptErrors([]);
    setPromptDialogOpen(false);
    setCreateKnowledgeErrors([]);
    setKnowledgeDialogOpen(true);
  }, [createDraft]);

  const handleKnowledgeDialogBack = useCallback(() => {
    setKnowledgeDialogOpen(false);
    setCreateKnowledgeErrors([]);
    setPromptDialogOpen(true);
  }, []);

  const handleKnowledgeDialogContinue = useCallback(() => {
    const v = validateKnowledgeStep(createDraft);
    if (!v.ok) {
      setCreateKnowledgeErrors(v.errors);
      return;
    }
    setCreateKnowledgeErrors([]);
    setKnowledgeDialogOpen(false);
    setCreateSaved(false);
    setSummaryDialogOpen(true);
  }, [createDraft]);

  const handleSummaryDialogBack = useCallback(() => {
    setSummaryDialogOpen(false);
    setCreateKnowledgeErrors([]);
    setKnowledgeDialogOpen(true);
  }, []);

  const handleSummarySave = useCallback(async () => {
    const prepared = {
      ...createDraft,
      systemPrompt: mergeModelBuilderIntoSystemPrompt(createDraft.systemPrompt, createDraft),
    };
    const name = (prepared.name || "").trim();
    if (!user?.id) {
      toast({
        title: "Sign in to save",
        description: "Your model config stays in this browser until you sign in.",
        variant: "destructive",
      });
      return;
    }
    if (!name || /^untitled model$/i.test(name) || resolveSystemPromptForDraft(prepared).trim().length < 20) {
      toast({
        title: "Not ready yet",
        description: "Add a name and system prompt (20+ characters) before saving.",
        variant: "destructive",
      });
      return;
    }
    setCreateSaving(true);
    try {
      const saved = await saveCustomModelDraft(prepared);
      const synced = apiModelToDraft(saved);
      if (!synced) throw new Error("Could not save model.");
      const published = await publishCustomModel(synced);
      const next = apiModelToDraft(published);
      if (next?.id) saveActiveCustomModelId(next.id);
      void refreshModels();
      window.dispatchEvent(new CustomEvent("lykn_custom_models_changed"));
      window.dispatchEvent(new CustomEvent("lykn_active_custom_model_changed"));
      setCreateSaved(true);
      createSavedRef.current = true;
      toast({
        title: "Saved to chat",
        description: `${next?.name || "Model"} is ready to use in /app.`,
      });
    } catch (e) {
      toast({
        title: "Could not save model",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCreateSaving(false);
    }
  }, [createDraft, user?.id, refreshModels]);

  const handleSummaryDialogOpenChange = useCallback((open) => {
    setSummaryDialogOpen(open);
    if (!open) {
      setCreateSaving(false);
      setCreateSaved(false);
      if (createSavedRef.current) {
        createSavedRef.current = false;
        setCreateDraft(emptyModelDraft());
      }
    }
  }, []);

  const handleSummaryDone = useCallback(() => {
    handleSummaryDialogOpenChange(false);
  }, [handleSummaryDialogOpenChange]);

  const handleOpenModel = useCallback(
    (model) => {
      const fromServer = apiModelToDraft(model);
      if (!fromServer) return;
      setSelectModelDialogOpen(false);
      enterBuilder(fromServer);
    },
    [enterBuilder],
  );

  const handleBackToHome = useCallback(() => {
    setView("home");
  }, []);

  const handleDeleteModel = useCallback(async () => {
    const id = String(draft.id || "").trim();
    if (!id) return;
    setDeleting(true);
    try {
      await deleteCustomModel(id);
      if (loadActiveCustomModelId() === id) {
        saveActiveCustomModelId(null);
      }
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      void refreshModels();
      window.dispatchEvent(new CustomEvent("lykn_custom_models_changed"));
      window.dispatchEvent(new CustomEvent("lykn_active_custom_model_changed"));
      toast({
        title: "Model deleted",
        description: `${draft.name?.trim() || "Model"} was removed.`,
      });
      setDraft(emptyModelDraft());
      setView("home");
    } catch (e) {
      toast({
        title: "Could not delete model",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }, [draft.id, draft.name, refreshModels]);

  const handleOpenSelectModel = useCallback(() => {
    setSelectModelDialogOpen(true);
    if (user?.id) void refreshModels();
  }, [user?.id, refreshModels]);

  useEffect(() => {
    if (!user?.id) return;
    fetchLatestTrainingSetJob()
      .then((job) => {
        if (job) setTrainingJob(job);
      })
      .catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const knowledge = trainingKnowledgeFromDraft(draft);
    fetchTrainingSourcesPreview({
      vaultSource: draft.vaultSource,
      includeChats: true,
      vaultTags: draft.vaultTags,
      ...knowledge,
    })
      .then((preview) => {
        setTrainingOptOut(!!preview.training_opt_out);
        setChatExchangeCount(preview.stats?.conversation_exchanges ?? 0);
      })
      .catch(() => {});
  }, [
    user?.id,
    draft.vaultSource,
    draft.vaultTags,
    draft.includedVaultNoteIds,
    draft.synthesisKnowledgeMode,
    draft.excludedSynthesisBeliefIds,
    draft.includedSynthesisNeurons,
  ]);

  useEffect(() => {
    if (wakePreview) return;
    fetchLoraConfig()
      .then((cfg) => setLoraConfigured(!!cfg?.configured))
      .catch(() => setLoraConfigured(false));
  }, [wakePreview]);

  useEffect(() => {
    if (!user?.id || !draft.id) {
      setLoraJob(null);
      return;
    }
    fetchLatestLoraJob(draft.id)
      .then((job) => setLoraJob(job || null))
      .catch(() => setLoraJob(null));
  }, [user?.id, draft.id]);

  const patch = useCallback((partial) => {
    setDraft((d) => ({ ...d, ...partial, updatedAt: new Date().toISOString() }));
  }, []);

  const trainingSetIdForLink = () =>
    trainingJob?.status === "ready" ? trainingJob.id : draft.trainingSetId || null;

  const handleDeploy = async () => {
    if (!canPublish) {
      toast({
        title: "Not ready yet",
        description: "Add a name and system prompt (20+ characters) before deploying.",
        variant: "destructive",
      });
      return;
    }
    setPublishing(true);
    try {
      const saved = await saveCustomModelDraft(draft, {
        trainingSetId: trainingSetIdForLink(),
      });
      const synced = apiModelToDraft(saved);
      if (!synced) throw new Error("Could not save model before deploy.");
      setDraft((d) => ({ ...d, ...synced }));

      const model = await publishCustomModel(synced, {
        trainingSetId: trainingSetIdForLink(),
      });
      const next = apiModelToDraft(model);
      if (next) {
        setDraft((d) => ({ ...d, ...next }));
        if (next.id) saveActiveCustomModelId(next.id);
      }
      void refreshModels();
      window.dispatchEvent(new CustomEvent("lykn_custom_models_changed"));
      window.dispatchEvent(new CustomEvent("lykn_active_custom_model_changed"));
      toast({
        title: "Deployed to chat",
        description:
          next?.trainingSetId
            ? `${next.name || "Model"} is saved, published, and selected in /app.`
            : `${next.name || "Model"} is saved, published, and selected in main chat.`,
      });
    } catch (e) {
      toast({
        title: "Deploy failed",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPublishing(false);
    }
  };

  const handleGenerateTrainingSet = async () => {
    if (!user) {
      toast({
        title: "Sign in to generate",
        description: "Connect your synthesis layer before building a training set.",
        variant: "destructive",
      });
      return;
    }
    setTrainingBusy(true);
    setTrainingSim({ pct: 8, label: "Starting job…" });
    setTrainingJob(null);
    try {
      const knowledge = trainingKnowledgeFromDraft(draft);
      const started = await startTrainingSetGeneration({
        vaultSource: draft.vaultSource,
        includeChats: draft.includeChats,
        vaultTags: draft.vaultTags,
        ...knowledge,
      });
      setTrainingJob(started);
      const final = await pollTrainingSetJob(started.id, {
        onTick: (job) => {
          setTrainingJob(job);
          setTrainingSim({
            pct: trainingJobProgress(job.status),
            label: trainingJobLabel(job.status, job),
          });
        },
      });
      const fresh = await fetchTrainingSetJob(started.id);
      setTrainingJob(fresh);
      setTrainingSim(null);
      if (fresh.status === "ready") {
        const src = formatTrainingSourceSummary(fresh.metadata);
        toast({
          title: "Training set ready",
          description: src
            ? `${fresh.metadata?.total_pairs ?? "?"} pairs (${src}).`
            : `${fresh.metadata?.total_pairs ?? "?"} training pairs ready.`,
        });
      } else {
        toast({
          title: "Generation failed",
          description: fresh.error_message || final.error_message || "Try again in a few minutes.",
          variant: "destructive",
        });
      }
    } catch (e) {
      setTrainingSim(null);
      try {
        const latest = await fetchLatestTrainingSetJob();
        if (latest) setTrainingJob(latest);
      } catch {
        /* keep cleared state */
      }
      toast({
        title: "Could not generate training set",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setTrainingBusy(false);
    }
  };

  const handleStartLora = async () => {
    if (!user) {
      toast({
        title: "Sign in required",
        description: "LoRA training runs on your account.",
        variant: "destructive",
      });
      return;
    }
    if (draft.trainingMode !== "lora") {
      toast({
        title: "Select LoRA mode",
        description: "Choose LoRA fine-tune in the training modes list.",
        variant: "destructive",
      });
      return;
    }
    if (!trainingJob?.id || trainingJob.status !== "ready") {
      toast({
        title: "Training set required",
        description: "Generate a JSONL training set first.",
        variant: "destructive",
      });
      return;
    }
    setLoraBusy(true);
    setLoraSim({ pct: 12, label: "Syncing model config…" });
    try {
      // Always persist current UI (training mode, base, epochs) before LoRA:
      // the server reads lykn_custom_models, not localStorage.
      const saved = await saveCustomModelDraft(draft, {
        trainingSetId: trainingSetIdForLink(),
      });
      const synced = apiModelToDraft(saved);
      if (!synced?.id) throw new Error("Save your model draft before starting LoRA.");
      setDraft((d) => ({ ...d, ...synced }));
      const modelId = synced.id;

      setLoraSim({ pct: 12, label: "Starting LoRA job…" });
      const job = await startLoraTraining(modelId, {
        trainingSetId: trainingJob.id,
      });
      setLoraJob(job);
      const final = await pollLoraJob(job.id, {
        onTick: (j) => {
          setLoraJob(j);
          setLoraSim({
            pct: loraJobProgress(j.status),
            label: loraJobLabel(j.status, j),
          });
        },
      });
      setLoraJob(final);
      setLoraSim(null);
      if (final.status === "ready") {
        window.dispatchEvent(new CustomEvent("lykn_custom_models_changed"));
        toast({
          title: "LoRA adapter ready",
          description: final.outputModelId
            ? `Inference model: ${final.outputModelId}`
            : "Use this model in chat to apply your weights.",
        });
      } else {
        toast({
          title: "LoRA failed",
          description: final.errorMessage || "Check server logs or Together dashboard.",
          variant: "destructive",
        });
      }
    } catch (e) {
      setLoraSim(null);
      try {
        if (draft.id) {
          const latest = await fetchLatestLoraJob(draft.id);
          if (latest) setLoraJob(latest);
        }
      } catch {
        /* ignore */
      }
      toast({
        title: "LoRA could not start",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoraBusy(false);
    }
  };

  const handleDownloadTrainingSet = async (format = "canonical") => {
    if (!trainingJob?.id || trainingJob.status !== "ready") return;
    try {
      const blob = await downloadTrainingSetFile(trainingJob.id, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lykn-training-${trainingJob.id}.${format === "openai" ? "openai.jsonl" : "jsonl"}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast({
        title: "Download failed",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    }
  };

  const resolvedPrompt = resolveSystemPromptForDraft(draft);

  const renderTrainingStep = () => (
          <div className="space-y-5">
            <p className="text-[11px] rounded-lg border border-black/8 dark:border-white/10 px-3 py-2 bg-black/[0.02] dark:bg-white/[0.03]">
              Approach:{" "}
              <span className="font-semibold text-foreground">
                {TRAINING_MODES.find((m) => m.id === draft.trainingMode)?.label || draft.trainingMode}
              </span>
              . Change in{" "}
              <button
                type="button"
                className="text-blue-600 dark:text-blue-400 font-medium hover:underline"
                onClick={() => goToStep(0)}
              >
                Basics
              </button>
              .
            </p>
            <label
              className={cn(
                "flex items-start gap-3 rounded-xl border px-3.5 py-3 cursor-pointer transition-colors",
                draft.includeChats
                  ? "border-green-500/40 bg-green-500/10"
                  : "border-black/8 dark:border-white/10",
                trainingOptOut && "opacity-60 cursor-not-allowed",
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 accent-green-600"
                checked={!!draft.includeChats}
                disabled={trainingOptOut}
                onChange={(e) => patch({ includeChats: e.target.checked })}
              />
              <span className="text-[12px] leading-snug">
                <span className="font-semibold text-foreground block">Include past conversations</span>
                <span className="text-muted-foreground">
                  Uses saved exchanges from your main chat (/app). Grid and vault chat are not included. Up
                  to ~60 pairs per run.
                  {chatExchangeCount != null ? ` ${chatExchangeCount} exchange(s) available.` : null}
                </span>
              </span>
            </label>
            {trainingOptOut ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                Chat training is off in your{" "}
                <Link to="/settings" className="underline font-medium">
                  privacy settings
                </Link>
                . Disable training opt-out to include conversations.
              </p>
            ) : null}
            {draft.trainingMode === "lora" && (
              <div className="space-y-2">
                <Label className="text-[11px]">LoRA epochs</Label>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={draft.trainingEpochs}
                  onChange={(e) => patch({ trainingEpochs: Number(e.target.value) })}
                  className="w-full accent-green-600"
                />
                <p className="text-[11px] text-muted-foreground text-right">{draft.trainingEpochs} epochs</p>
              </div>
            )}
            {trainingJob?.status === "ready" && trainingJob.metadata?.total_pairs ? (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-900/40 p-3 space-y-2 text-[11px]">
                <p className="font-medium text-foreground">
                  {trainingJob.metadata.total_pairs} training pairs ready
                </p>
                <p className="text-[10px] text-muted-foreground font-mono">{formatTrainingJobStamp(trainingJob)}</p>
                <p className="text-muted-foreground">
                  {formatTrainingSourceSummary(trainingJob.metadata) ||
                    `Sources: synthesis ${trainingJob.metadata.sources?.synthesis_layer ?? "None"}`}
                  {trainingJob.metadata.document_chunks_processed
                    ? ` · ${trainingJob.metadata.document_chunks_processed} vault chunk(s)`
                    : null}
                  {trainingJob.metadata.conversation_exchanges_used
                    ? ` · ${trainingJob.metadata.conversation_exchanges_used} chat exchange(s)`
                    : null}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => handleDownloadTrainingSet("canonical")}>
                    Download JSONL
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => handleDownloadTrainingSet("openai")}>
                    Export OpenAI format
                  </Button>
                </div>
              </div>
            ) : null}
            {trainingJob && trainingJob.status !== "ready" ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-3 text-[11px] text-muted-foreground">
                <p className="font-medium text-foreground capitalize">{trainingJob.status}</p>
                {trainingJob.error_message ? (
                  <p className="mt-1 text-amber-800 dark:text-amber-300">{trainingJob.error_message}</p>
                ) : (
                  <p className="mt-1">Generation in progress or waiting on the server…</p>
                )}
                <p className="mt-1 font-mono text-[10px]">{formatTrainingJobStamp(trainingJob)}</p>
              </div>
            ) : null}
            {trainingSim ? (
              <div className="rounded-xl border border-green-500/30 bg-green-500/8 p-4 space-y-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <Loader2 className="h-4 w-4 animate-spin text-green-600 dark:text-green-400" />
                  {trainingSim.label}
                </div>
                <Progress value={trainingSim.pct} className="h-1.5 bg-gray-200 dark:bg-gray-700 [&>div]:bg-green-600" />
              </div>
            ) : (
              <Button type="button" className="w-full" onClick={handleGenerateTrainingSet} disabled={trainingBusy}>
                <Play className="h-4 w-4" />
                Generate training set
              </Button>
            )}
            {draft.trainingMode === "lora" ? (
              <div className="rounded-xl border border-blue-500/25 bg-blue-500/5 p-3 space-y-3">
                <ModelBuilderWalletCard />
                <p className="text-[11px] text-muted-foreground">
                  LoRA runs on <span className="font-medium text-foreground">Together AI</span> using OpenAI-format
                  JSONL. Training is billed from your model budget above.
                  {!loraConfigured ? (
                    <span className="block mt-1 text-amber-700 dark:text-amber-400">
                      Server needs <code className="text-[10px]">TOGETHER_API_KEY</code>. Training is disabled until
                      set.
                    </span>
                  ) : null}
                </p>
                {loraJob?.status === "ready" && loraJob.outputModelId ? (
                  <div className="text-[11px] space-y-1">
                    <p className="font-medium text-green-800 dark:text-green-300">Adapter trained</p>
                    <p className="font-mono text-[10px] break-all text-muted-foreground">{loraJob.outputModelId}</p>
                    {loraJob.metadata?.lora_serverless_available === false ||
                    /Reference/i.test(loraJob.outputModelId || "") ? (
                      <p className="text-amber-800 dark:text-amber-300">
                        This adapter was trained on <span className="font-medium">Llama Reference</span>. Together only
                        serves it on a <span className="font-medium">dedicated endpoint</span>, not per-message serverless.
                        Retrain with the default <span className="font-medium">Qwen3 8B (LoRA)</span> base, or create a
                        dedicated endpoint in the Together dashboard.
                      </p>
                    ) : (
                    <p className="text-muted-foreground">
                      Chat calls your adapter id on{" "}
                      <span className="font-medium text-foreground">Together serverless</span> (same API as normal
                      chat, per token, no endpoint to start). First message may take a few seconds while weights load.
                    </p>
                    )}
                  </div>
                ) : loraJob && !["ready", "failed", "cancelled"].includes(loraJob.status) ? (
                  <p className="text-[11px] text-muted-foreground capitalize">{loraJobLabel(loraJob.status, loraJob)}</p>
                ) : null}
                {loraJob?.status === "failed" && loraJob.errorMessage ? (
                  <p className="text-[11px] text-amber-800 dark:text-amber-300">{loraJob.errorMessage}</p>
                ) : null}
                {loraSim ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-[12px]">
                      <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                      {loraSim.label}
                    </div>
                    <Progress value={loraSim.pct} className="h-1.5 bg-gray-200 dark:bg-gray-700 [&>div]:bg-blue-600" />
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    disabled={
                      loraBusy || trainingBusy || !loraConfigured || !trainingJob || trainingJob.status !== "ready"
                    }
                    onClick={() => void handleStartLora()}
                  >
                    <Upload className="h-4 w-4" />
                    Start LoRA training
                  </Button>
                )}
              </div>
            ) : null}
          </div>
  );


  return (
    <div
      className={cn(
        "model-builder-page w-full flex flex-col overflow-hidden omnia-grid-bg text-foreground",
        wakePreview ? "h-full min-h-0" : "min-h-[100svh]",
      )}
    >
      {view === "builder" ? (
      <ModelBuilderStepNav
        stepIndex={stepIndex}
        maxReachable={maxReachable}
        onBackToHome={handleBackToHome}
        onStepClick={(i) => {
          if (i === 0 || i <= maxReachable) goToStep(i);
        }}
      />
      ) : null}

      <div className="flex-1 min-h-0 flex flex-col">
      {view === "home" ? (
        <ModelBuilderHome
          onCreate={handleCreateModel}
          onEdit={handleOpenSelectModel}
          wakePreview={wakePreview}
        />
      ) : currentStageId === "basics" ? (
        <main className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-4 sm:px-6 py-6">
          <ModelBuilderStageBasics
            draft={draft}
            patch={patch}
            errors={basicsErrors}
            models={models}
            onDelete={handleDeleteModel}
            deleting={deleting}
          />
        </main>
      ) : currentStageId === "prompt" ? (
        <main className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-4 sm:px-6 py-6">
          <ModelBuilderStagePromptTools
            draft={draft}
            patch={patch}
            errors={promptErrors}
            resolvedPrompt={resolvedPrompt}
          />
        </main>
      ) : currentStageId === "publish" ? (
        <main className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-4 sm:px-6 py-6">
          <ModelBuilderStagePublish
            draft={draft}
            progress={progress}
            canPublish={canPublish}
            publishing={publishing}
            modelLoadDone={modelLoadDone}
            onDeploy={handleDeploy}
            trainingJob={trainingJob}
            loraJob={loraJob}
          />
        </main>
      ) : currentStageId === "configure" ? (
        <main className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-4 sm:px-6 py-6">
          <ModelBuilderStageKnowledge draft={draft} patch={patch} errors={knowledgeErrors} />
        </main>
      ) : currentStageId === "train" ? (
        <main className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-4 sm:px-6 py-6">
          <div className="mx-auto w-full max-w-lg space-y-6 py-2">
            <div>
              <h2 className="text-[18px] font-semibold tracking-tight">Training</h2>
              <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
                Build a JSONL corpus from your vault and conversations, then run LoRA when you are ready.
              </p>
            </div>
            {renderTrainingStep()}
          </div>
        </main>
      ) : null}

      {view === "builder" ? stepContinueBar : null}

      {view === "builder" && stepIndex === MODEL_BUILDER_STAGES.length - 1 ? (
        <div className="shrink-0 w-full flex justify-center px-4 sm:px-6 pb-10 pt-2">
          <div className="w-full max-w-lg flex justify-start pl-0">
            <Button type="button" variant="ghost" size="sm" onClick={handleBack}>
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
          </div>
        </div>
      ) : null}
      </div>

      {!user && !wakePreview && (
        <div className="shrink-0 px-4 py-2 text-center text-[11px] bg-gray-100 dark:bg-gray-900/60 border-t border-gray-300/40 dark:border-gray-600/40 text-gray-800 dark:text-gray-200">
          <Link to="/login" className="font-semibold underline">
            Sign in
          </Link>{" "}
          to sync beliefs from your synthesis layer and run real training later.
        </div>
      )}

      <ModelBuilderSelectModelDialog
        open={selectModelDialogOpen}
        onOpenChange={setSelectModelDialogOpen}
        models={models}
        loading={modelsLoading}
        onSelectModel={handleOpenModel}
        onCreateNew={handleCreateModel}
      />

      <ModelBuilderNewModelDialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) setCreateErrors([]);
        }}
        draft={createDraft}
        patch={patchCreateDraft}
        errors={createErrors}
        otherModels={models}
        onContinue={handleCreateDialogContinue}
      />

      <ModelBuilderPromptToolsDialog
        open={promptDialogOpen}
        onOpenChange={(open) => {
          setPromptDialogOpen(open);
          if (!open) setPromptErrors([]);
        }}
        draft={createDraft}
        patch={patchCreateDraft}
        errors={promptErrors}
        resolvedPrompt={createResolvedPrompt}
        onBack={handlePromptDialogBack}
        onContinue={handlePromptDialogContinue}
      />

      <ModelBuilderKnowledgeDialog
        open={knowledgeDialogOpen}
        onOpenChange={(open) => {
          setKnowledgeDialogOpen(open);
          if (!open) setCreateKnowledgeErrors([]);
        }}
        draft={createDraft}
        patch={patchCreateDraft}
        errors={createKnowledgeErrors}
        onBack={handleKnowledgeDialogBack}
        onContinue={handleKnowledgeDialogContinue}
      />

      <ModelBuilderSummaryDialog
        open={summaryDialogOpen}
        onOpenChange={handleSummaryDialogOpenChange}
        draft={createDraft}
        user={user}
        saving={createSaving}
        saved={createSaved}
        onBack={handleSummaryDialogBack}
        onSave={handleSummarySave}
        onDone={handleSummaryDone}
      />
    </div>
  );
}
