import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createUserProject } from "@/lib/userProjects";
import { useAuth } from "@/lib/SupabaseAuth";
import { toast } from "@/components/ui/use-toast";

export default function ModelBuilderCreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = useCallback(() => {
    setName("");
    setDescription("");
    setSaving(false);
  }, []);

  const handleOpenChange = useCallback(
    (next) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    if (!user?.id) {
      toast({
        title: "Sign in required",
        description: "Sign in to create a LYKN project.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const project = await createUserProject(user.id, {
        name: trimmed,
        description: description.trim() || null,
        members: [],
      });
      if (!project?.id) {
        throw new Error("Project was not created.");
      }
      onCreated?.(project);
      reset();
      onOpenChange(false);
      toast({
        title: "Project created",
        description: `"${project.name}" is linked to this model.`,
      });
    } catch (e) {
      toast({
        title: "Could not create project",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [description, name, onCreated, onOpenChange, reset, saving, user?.id]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0 overflow-hidden sm:rounded-xl">
        <DialogHeader className="px-5 pt-5 pb-3 space-y-1.5 text-left">
          <DialogTitle className="text-[17px] font-semibold tracking-tight">
            Create new project
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            Projects group synthesis neurons and working memory. Link one so this model loads that
            context in chat.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-4 space-y-4">
          <div className="space-y-2">
            <label htmlFor="model-builder-project-name" className="text-[11px] font-medium text-foreground">
              Project name
            </label>
            <Input
              id="model-builder-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
              placeholder="e.g. Q1 fundraising deck"
              className="h-10 text-[13px] rounded-xl"
            />
          </div>
          <div className="space-y-2">
            <label
              htmlFor="model-builder-project-description"
              className="text-[11px] font-medium text-foreground"
            >
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea
              id="model-builder-project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={320}
              placeholder="What is this project about?"
              className="text-[13px] leading-relaxed resize-none rounded-xl"
            />
          </div>
        </div>

        <DialogFooter className="px-5 py-4 border-t border-black/8 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] sm:justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleCreate()}
            disabled={!name.trim() || saving}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
