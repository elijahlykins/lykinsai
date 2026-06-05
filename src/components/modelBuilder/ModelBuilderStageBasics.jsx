import ModelBuilderBasicsForm from "@/components/modelBuilder/ModelBuilderBasicsForm";
import ModelBuilderDeleteModelSection from "@/components/modelBuilder/ModelBuilderDeleteModelSection";

export default function ModelBuilderStageBasics({
  draft,
  patch,
  errors = [],
  models = [],
  onDelete,
  deleting = false,
}) {
  return (
    <div className="mx-auto w-full max-w-lg space-y-6 py-2">
      <div>
        <h2 className="text-[18px] font-semibold tracking-tight">Model basics</h2>
        <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
          Update name, engine, and response style. Beliefs, prompts, and training are in the next steps.
        </p>
      </div>

      <ModelBuilderBasicsForm
        draft={draft}
        patch={patch}
        errors={errors}
        showTrainingSection
        showOrchestrationSection
        otherModels={models}
      />

      {draft.id && onDelete ? (
        <ModelBuilderDeleteModelSection
          modelName={draft.name}
          onDelete={onDelete}
          deleting={deleting}
        />
      ) : null}
    </div>
  );
}
