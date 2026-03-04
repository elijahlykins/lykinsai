import React, { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
type Project = {
  id: string;
  name: string;
  updated_at?: string | null;
  created_at?: string | null;
  cover_image_url?: string | null;
  image_url?: string | null;
  thumbnail_url?: string | null;
  coverImage?: string | null;
  image?: string | null;
  thumbnail?: string | null;
};

type LinkedTeam = {
  id: string;
  name: string;
  color: string;
};

type ProjectGridProps = {
  projects: Project[];
  onSelect?: (project: Project) => void;
  onRename?: (project: Project, name: string) => void;
  onDelete?: (project: Project) => void | Promise<void>;
  fallbackInitials?: string;
  onSetProjectImage?: (projectId: string, dataUrl: string) => void | Promise<void>;
  teamsByProject?: Record<string, LinkedTeam[]>;
  onCreateNew?: () => void;
  onAddTeamMembers?: (project: Project) => void;
};

const PROJECT_CARD_IMAGES_KEY = "omnia_project_card_images";

function readProjectCardImages(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PROJECT_CARD_IMAGES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function getProjectImage(project: Project) {
  return (
    project.cover_image_url ||
    project.image_url ||
    project.thumbnail_url ||
    project.coverImage ||
    project.image ||
    project.thumbnail ||
    ""
  );
}

function getGridCols(count: number) {
  if (count <= 1) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 3) return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
}

export default function ProjectGrid({
  projects,
  onSelect,
  onRename,
  onDelete,
  fallbackInitials = "?",
  onSetProjectImage,
  teamsByProject = {},
  onCreateNew,
  onAddTeamMembers,
}: ProjectGridProps) {
  if (!projects.length) {
    return (
      <div className="rounded-2xl border border-white/60 bg-white/18 backdrop-blur-lg shadow-xl shadow-white/20 p-8 text-center text-black/70">
        No projects yet. Create your first one!
      </div>
    );
  }

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [uploadProjectId, setUploadProjectId] = useState<string | null>(null);
  const [localImageMap, setLocalImageMap] = useState<Record<string, string>>(() => readProjectCardImages());
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(event.target as Node)) return;
      setOpenMenuId(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const handleImageFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const projectId = uploadProjectId;
    event.target.value = "";
    if (!file || !projectId) return;

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Failed to read image"));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      if (!dataUrl) return;
      await onSetProjectImage?.(projectId, dataUrl);
      setLocalImageMap((prev) => {
        const next = { ...prev, [projectId]: dataUrl };
        try {
          localStorage.setItem(PROJECT_CARD_IMAGES_KEY, JSON.stringify(next));
        } catch {
          // ignore storage errors
        }
        return next;
      });
    } catch {
      // ignore file read errors
    } finally {
      setUploadProjectId(null);
    }
  };

  return (
    <div className="px-2 sm:px-0">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageFileChange}
      />
      <div className={`grid ${getGridCols(projects.length)} gap-4`}>
        {onCreateNew && (
          <button
            type="button"
            onClick={onCreateNew}
            className="group/add relative min-h-[220px] rounded-2xl border-2 border-dashed border-black/10 dark:border-white/10 hover:border-blue-500/40 dark:hover:border-blue-400/40 p-4 flex flex-col items-center justify-center text-center transition-all hover:bg-blue-500/[0.04] dark:hover:bg-blue-400/[0.04]"
          >
            <div className="w-12 h-12 rounded-full bg-blue-500/10 dark:bg-blue-400/10 flex items-center justify-center mb-3 group-hover/add:bg-blue-500/20 dark:group-hover/add:bg-blue-400/20 transition-colors">
              <Plus className="w-6 h-6 text-blue-500 dark:text-blue-400" />
            </div>
            <span className="text-sm font-medium text-black/40 dark:text-white/40 group-hover/add:text-blue-500 dark:group-hover/add:text-blue-400 transition-colors">
              New Project
            </span>
          </button>
        )}
        {projects.map((project) => (
        <div
          key={project.id}
          className="group relative min-h-[220px] rounded-2xl border border-white/30 bg-[rgba(160,160,170,0.25)] backdrop-blur-[30px] backdrop-saturate-[1.4] p-4 text-black shadow-[0_2px_8px_rgba(0,0,0,0.06)] transition-transform hover:scale-[1.02] hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)] flex items-center justify-center text-center overflow-hidden"
        >
          {(() => {
            const localImg = localImageMap[project.id];
            const imageSrc = localImg === "__removed__" ? "" : (localImg || getProjectImage(project));
            return (
              <div className="relative z-20 w-full flex flex-col items-center px-1 pt-1 pb-2 pointer-events-none">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setUploadProjectId(project.id);
                    fileInputRef.current?.click();
                  }}
                  className="h-24 w-full rounded-xl border border-white/60 bg-white/25 backdrop-blur-md overflow-hidden shadow-lg shadow-white/20 flex items-center justify-center pointer-events-auto hover:bg-white/30 transition-colors"
                  title={imageSrc ? "Change project image" : "Add project image"}
                  aria-label={imageSrc ? `Change image for ${project.name}` : `Add image for ${project.name}`}
                >
                  {imageSrc ? (
                    <img src={imageSrc} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xl font-semibold text-black/70">{fallbackInitials}</span>
                  )}
                </button>

                <div className="mt-4 w-full px-1 text-left min-h-[44px] flex flex-col justify-between">
                  <h3 className="text-sm font-semibold drop-shadow-[0_0_8px_rgba(255,255,255,0.55)] leading-tight line-clamp-1">
                    {project.name}
                  </h3>
                  <div className="mt-1 text-[0.6875rem] text-black/55 leading-tight">
                    Last modified: {formatDate(project.updated_at || project.created_at)}
                  </div>
                  {(teamsByProject[project.id] ?? []).length > 0 && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <div className="flex -space-x-1.5">
                        {(teamsByProject[project.id] ?? []).map((team) => (
                          <div
                            key={team.id}
                            className="w-6 h-6 rounded-full border-2 border-white flex items-center justify-center text-[8px] font-bold text-white shrink-0"
                            style={{ background: team.color }}
                            title={team.name}
                          >
                            {team.name.split(/\s+/).slice(0, 2).map((w: string) => w.charAt(0).toUpperCase()).join("")}
                          </div>
                        ))}
                      </div>
                      <span className="text-[9px] text-black/45 truncate">
                        {(teamsByProject[project.id] ?? []).map((t) => t.name).join(", ")}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          <div className="absolute inset-0 rounded-2xl ring-1 ring-white/40 pointer-events-none" />
          <button
            type="button"
            onClick={() => onSelect?.(project)}
            className="absolute inset-0 z-10"
            aria-label={`Open ${project.name}`}
          />
          <div className="absolute top-2 right-2 z-30 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="relative" ref={openMenuId === project.id ? menuRef : null}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId((prev) => (prev === project.id ? null : project.id));
                }}
                className="w-7 h-7 rounded-full hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
                aria-label="Project actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {openMenuId === project.id && (
                <div className="absolute right-0 mt-2 w-44 rounded-xl border border-white/60 bg-white/80 backdrop-blur-md shadow-xl p-2">
                  <button
                    type="button"
                    className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5"
                    onClick={() => {
                      const next = window.prompt("Rename project", project.name);
                      if (!next || !next.trim()) return;
                      onRename?.(project, next.trim());
                      setOpenMenuId(null);
                    }}
                  >
                    Rename project
                  </button>
                  <button
                    type="button"
                    className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5"
                    onClick={() => {
                      onAddTeamMembers?.(project);
                      setOpenMenuId(null);
                    }}
                  >
                    Add team members
                  </button>
                  {localImageMap[project.id] !== "__removed__" && (localImageMap[project.id] || getProjectImage(project)) && (
                    <button
                      type="button"
                      className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5"
                      onClick={() => {
                        setLocalImageMap((prev) => {
                          const next = { ...prev, [project.id]: "__removed__" };
                          try {
                            localStorage.setItem(PROJECT_CARD_IMAGES_KEY, JSON.stringify(next));
                          } catch { /* ignore */ }
                          return next;
                        });
                        void onSetProjectImage?.(project.id, "");
                        setOpenMenuId(null);
                      }}
                    >
                      Remove cover image
                    </button>
                  )}
                  <button
                    type="button"
                    className="w-full text-left text-xs px-2 py-2 rounded-lg text-red-600 hover:bg-red-50"
                    onClick={async () => {
                      const ok = window.confirm(`Delete "${project.name}"? This cannot be undone.`);
                      if (!ok) return;
                      await onDelete?.(project);
                      setOpenMenuId(null);
                    }}
                  >
                    Delete project
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        ))}
      </div>
    </div>
  );
}
