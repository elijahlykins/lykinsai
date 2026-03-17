import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Search as SearchIcon,
  StickyNote,
  Plus,
  Activity,
  Clock,
  Eye,
  Zap,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  BookOpen,
  X,
  PanelRightClose,
  Image as ImageIcon,
  Video,
  FileText,
  Link2,
  FileIcon,
  Music,
  MoreHorizontal,
  Trash2,
  Download,
  Pencil,
  BrickWall,
  LayoutGrid,
  Table,
} from "lucide-react";
import DraggableChat from "@/components/notes/DraggableChat";
import DraggableQuickNote from "@/components/notes/DraggableQuickNote";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery } from "@tanstack/react-query";
import { normalizeValueToV2, getBlockPlainText } from "@/components/notes/blockModel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "@/canvas/utils/youtube";
import { getAiPrefs } from "@/lib/ai-prefs";

const PROJECTS_CHANGED_EVENT = "lykinsai_projects_changed";

type FolderEntry = {
  id: string;
  name: string;
  parentId: string | null;
};

type BoardEntry = {
  id: string;
  title: string;
  folderId: string | null;
};

type SpreadsheetData = {
  rows: number;
  cols: number;
  cells: Record<string, string>;
};

type FileEntry = {
  id: string;
  name: string;
  path: string;
  folderId: string | null;
  kind: "image" | "video" | "audio" | "pdf" | "doc" | "spreadsheet" | "link" | "file";
  url: string;
  storagePath?: string;
  storageBucket?: string;
  content?: string;
  spreadsheetData?: SpreadsheetData;
  size?: number;
};

function decodeBrickTextFromContent(contentHtml) {
  const html = contentHtml ?? "";
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const pre = doc.querySelector(`pre[data-brick-grid="true"]`);
    if (pre) return pre.textContent ?? "";
    return doc.body?.textContent ?? "";
  } catch {
    return String(html).replace(/<[^>]*>/g, "");
  }
}

function summarizeBrickV2ForAI(v2Payload) {
  const blocks = Array.isArray(v2Payload?.blocks) ? v2Payload.blocks : [];
  if (blocks.length === 0) return "(empty canvas)";
  const lines = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i] || {};
    const type = b.type || "Unknown";
    const pos = `x:${Number.isFinite(b.x) ? b.x : 0}, y:${Number.isFinite(b.y) ? b.y : 0}, w:${b.width ?? "?"}, h:${b.height ?? "?"}`;
    const plain = getBlockPlainText(b) || "";
    const oneLine = plain.replace(/\s+/g, " ").trim();
    const clipped = oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
    lines.push(`- [${type}] (${pos}) ${clipped}`.trim());
  }
  return lines.join("\n");
}

function summarizeNoteContentForAI(contentHtml) {
  const raw = decodeBrickTextFromContent(contentHtml);
  const v2 = normalizeValueToV2(raw, { defaultBlockWidthBricks: 14 });
  return summarizeBrickV2ForAI(v2);
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function storeValue<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export default function ProjectPlaceholder() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const [projectName, setProjectName] = useState("Project");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("Project");
  const [search, setSearch] = useState("");
  const [bottomTab, setBottomTab] = useState<"connections" | "graph">("graph");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [boards, setBoards] = useState<BoardEntry[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const [openFileMenuId, setOpenFileMenuId] = useState<string | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const [resolvedUrls, setResolvedUrls] = useState<Record<string, string>>({});
  const signedUrlCacheRef = useRef<Map<string, string>>(new Map());

  const [topPanelOpen, setTopPanelOpen] = useState(true);
  const [showMemorySidebar, setShowMemorySidebar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [quickNoteTitle, setQuickNoteTitle] = useState("");
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [openBoardMenuId, setOpenBoardMenuId] = useState<string | null>(null);
  const boardMenuRef = useRef<HTMLDivElement | null>(null);
  const [moveBoardId, setMoveBoardId] = useState<string | null>(null);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const mapRef = useRef<HTMLDivElement | null>(null);
  const lastPanRef = useRef<{ x: number; y: number } | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => {
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.aiModel) {
          return parsed.aiModel;
        }
      }
    } catch {
      // ignore
    }
    return "gemini-flash-latest";
  });

  // --- Project Health tracking ---
  const healthStorageKey = `project_health_${projectId}`;

  const [healthData, setHealthData] = useState(() => {
    try {
      const saved = localStorage.getItem(healthStorageKey);
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return { visits: 0, totalSeconds: 0, lastVisit: null as string | null };
  });

  useEffect(() => {
    setHealthData((prev: typeof healthData) => {
      const now = new Date().toISOString();
      const updated = { ...prev, visits: prev.visits + 1, lastVisit: now };
      localStorage.setItem(healthStorageKey, JSON.stringify(updated));
      return updated;
    });

    const interval = setInterval(() => {
      setHealthData((prev: typeof healthData) => {
        const updated = { ...prev, totalSeconds: prev.totalSeconds + 30 };
        localStorage.setItem(healthStorageKey, JSON.stringify(updated));
        return updated;
      });
    }, 30_000);
    return () => clearInterval(interval);
  }, [healthStorageKey]);

  const projectHealth = useMemo(() => {
    const { visits, totalSeconds, lastVisit } = healthData;
    let score = 0;

    // Frequency: more visits = healthier (max 40 pts)
    if (visits >= 20) score += 40;
    else if (visits >= 10) score += 30;
    else if (visits >= 5) score += 20;
    else if (visits >= 2) score += 10;
    else score += 5;

    // Recency: recent edits = healthier (max 35 pts)
    if (lastVisit) {
      const daysSince = (Date.now() - new Date(lastVisit).getTime()) / (1000 * 60 * 60 * 24 * 7);
      if (daysSince < 1) score += 35;
      else if (daysSince < 3) score += 25;
      else if (daysSince < 7) score += 15;
      else if (daysSince < 14) score += 8;
      else score += 2;
    }

    // Time spent: more time = healthier (max 25 pts)
    const minutes = totalSeconds / 60;
    if (minutes >= 120) score += 25;
    else if (minutes >= 60) score += 20;
    else if (minutes >= 30) score += 15;
    else if (minutes >= 10) score += 10;
    else score += 3;

    const clamped = Math.min(100, Math.max(0, score));
    let label: string;
    let color: string;
    if (clamped >= 80) { label = "Excellent"; color = "#22c55e"; }
    else if (clamped >= 60) { label = "Good"; color = "#84cc16"; }
    else if (clamped >= 40) { label = "Fair"; color = "#eab308"; }
    else if (clamped >= 20) { label = "Needs Attention"; color = "#f97316"; }
    else { label = "Inactive"; color = "#ef4444"; }

    return { score: clamped, label, color, visits, totalSeconds, lastVisit };
  }, [healthData]);

  const formatTimeSpent = (seconds: number) => {
    if (seconds < 60) return "< 1 min";
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  };

  const formatLastVisit = (iso: string | null) => {
    if (!iso) return "Never";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  useEffect(() => {
    const handleSettingsChange = () => {
      try {
        const saved = localStorage.getItem("lykinsai_settings");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.aiModel) {
            setSelectedModel(parsed.aiModel);
          }
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener("lykinsai_settings_changed", handleSettingsChange);
    window.addEventListener("storage", handleSettingsChange);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", handleSettingsChange);
      window.removeEventListener("storage", handleSettingsChange);
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "omnia-memory-drag-start") {
        (window as any).__omnia_pending_memory = event.data.data;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!boardMenuRef.current) return;
      if (boardMenuRef.current.contains(event.target as Node)) return;
      setOpenBoardMenuId(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!fileMenuRef.current) return;
      if (fileMenuRef.current.contains(event.target as Node)) return;
      setOpenFileMenuId(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const key = `project:${projectId}`;
    const stored = readStored(key, {
      folders: [] as FolderEntry[],
      files: [] as FileEntry[],
      activeFolderId: null as string | null,
    });
    setFolders(stored.folders);
    setFiles(stored.files);
    setActiveFolderId(stored.activeFolderId);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const filesToStore = files.map((f) => {
      if (f.storagePath) {
        return { ...f, url: "" };
      }
      return f;
    });
    storeValue(`project:${projectId}`, { folders, files: filesToStore, activeFolderId });
  }, [activeFolderId, files, folders, projectId]);

  const unresolvedFiles = useMemo(
    () => files.filter((f) => f.storagePath && f.storageBucket && !signedUrlCacheRef.current.has(`${f.storageBucket}:${f.storagePath}`)),
    [files]
  );

  useEffect(() => {
    if (!user?.id || files.length === 0) return;

    // Populate from cache first
    const cached: Record<string, string> = {};
    for (const f of files) {
      if (!f.storagePath || !f.storageBucket) continue;
      const cacheKey = `${f.storageBucket}:${f.storagePath}`;
      const hit = signedUrlCacheRef.current.get(cacheKey);
      if (hit) cached[f.id] = hit;
    }
    if (Object.keys(cached).length > 0) {
      setResolvedUrls((prev) => ({ ...prev, ...cached }));
    }

    if (unresolvedFiles.length === 0) return;
    let active = true;

    const resolveSignedUrls = async () => {
      const CONCURRENCY = 5;
      for (let i = 0; i < unresolvedFiles.length; i += CONCURRENCY) {
        if (!active) return;
        const batch = unresolvedFiles.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (file) => {
            const { data } = await supabase.storage
              .from(file.storageBucket!)
              .createSignedUrl(file.storagePath!, 60 * 60 * 24 * 7);
            return { fileId: file.id, bucket: file.storageBucket!, path: file.storagePath!, url: data?.signedUrl };
          })
        );
        if (!active) return;
        const next: Record<string, string> = {};
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.url) {
            signedUrlCacheRef.current.set(`${r.value.bucket}:${r.value.path}`, r.value.url);
            next[r.value.fileId] = r.value.url;
          }
        }
        if (Object.keys(next).length > 0) {
          setResolvedUrls((prev) => ({ ...prev, ...next }));
        }
      }
    };

    void resolveSignedUrls();
    return () => { active = false; };
  }, [files, unresolvedFiles, user?.id]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const loadProject = async () => {
      const { data } = await supabase
        .from("omnia_projects")
        .select("name")
        .eq("id", projectId)
        .maybeSingle();
      if (!cancelled && data?.name) {
        setProjectName(data.name);
        setDraftTitle(data.name);
      }
    };
    loadProject();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !user?.id) return;
    let cancelled = false;
    const loadBoards = async () => {
      const { data } = await supabase
        .from("omnia_boards")
        .select("id, title")
        .eq("user_id", user.id)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (cancelled) return;
      const folderMap = readStored<Record<string, string | null>>(
        `project:${projectId}:boardFolders`,
        {}
      );
      const mapped = (data || []).map((b: { id: string; title: string }) => ({
        id: b.id,
        title: b.title,
        folderId: folderMap[b.id] ?? null,
      }));
      setBoards(mapped);
    };
    loadBoards();
    return () => {
      cancelled = true;
    };
  }, [projectId, user?.id]);

  const { data: allNotes = [] } = useQuery({
    queryKey: ["notes-list", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      try {
        let { data, error } = await supabase
          .from("notes")
          .select("id, title, created_at, updated_at")
          .eq("user_id", user?.id || "")
          .order("created_at", { ascending: false })
          .limit(50);
        if (error && (error.code === "PGRST204" || error.message?.includes("Could not find"))) {
          ({ data, error } = await supabase
            .from("notes")
            .select("id, title")
            .eq("user_id", user?.id || "")
            .order("id", { ascending: false })
            .limit(50));
        }
        if (error) return [];
        return data || [];
      } catch {
        return [];
      }
    },
    retry: 2,
    refetchOnWindowFocus: false,
  });

  const { data: allProjects = [] } = useQuery({
    queryKey: ["projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("omnia_projects")
        .select("id, name")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(100);
      return data || [];
    },
    retry: 2,
    refetchOnWindowFocus: false,
  });

  const filteredBoards = useMemo(() => {
    const base = activeFolderId ? boards.filter((b) => b.folderId === activeFolderId) : boards;
    if (!search.trim()) return base;
    return base.filter((b) => b.title.toLowerCase().includes(search.toLowerCase()));
  }, [activeFolderId, boards, search]);

  const folderFiles = useMemo(() => {
    return files.filter((f) => f.folderId === activeFolderId);
  }, [activeFolderId, files]);

  const allFilesForCollage = useMemo(() => files, [files]);

  const projectSummary = useMemo(() => {
    const lastFile = files[0];
    const lastBoard = boards[0];
    const lastFolder = folders[folders.length - 1];
    let lastActivity = "No recent activity yet.";
    if (lastFile) lastActivity = `Last added file: ${lastFile.name}.`;
    else if (lastBoard) lastActivity = `Last created board: ${lastBoard.title}.`;
    else if (lastFolder) lastActivity = `Last created folder: ${lastFolder.name}.`;

    const suggestions: string[] = [];
    if (boards.length === 0) suggestions.push("Create a board to capture ideas.");
    if (folders.length === 0) suggestions.push("Add folders to organize files.");
    if (files.length === 0) suggestions.push("Drop files into a folder to get started.");
    if (files.length > 0 && boards.length > 0) suggestions.push("Connect files to boards in Connections.");
    if (boards.length > 3) suggestions.push("Group related boards under folders.");
    if (suggestions.length === 0) suggestions.push("Keep building — everything looks organized.");

    return {
      summary: `You have ${boards.length} board${boards.length === 1 ? "" : "s"}, ${folders.length} folder${
        folders.length === 1 ? "" : "s"
      }, and ${files.length} file${files.length === 1 ? "" : "s"} in this project. ${lastActivity}`,
      suggestions: suggestions.slice(0, 4),
    };
  }, [boards, files, folders]);

  const handleCreateBoard = async () => {
    if (!user?.id || !projectId) return;
    const { data } = await supabase
      .from("omnia_boards")
      .insert({ user_id: user.id, title: "New Board", project_id: projectId })
      .select("id, title")
      .single();
    const id = data?.id;
    if (id) {
      setBoards((prev) => [{ id, title: data?.title || "New Board", folderId: activeFolderId }, ...prev]);
      const folderMap = readStored<Record<string, string | null>>(
        `project:${projectId}:boardFolders`,
        {}
      );
      folderMap[id] = activeFolderId;
      storeValue(`project:${projectId}:boardFolders`, folderMap);
      localStorage.setItem("omnia_board_id", id);
      nav(`/canvas/${id}`);
    }
  };

  const handleRenameBoard = async (board: BoardEntry) => {
    if (!user?.id) return;
    const next = window.prompt("Rename board", board.title);
    if (next === null) return;
    const name = next.trim() || "New Board";
    await supabase
      .from("omnia_boards")
      .update({ title: name })
      .eq("id", board.id)
      .eq("user_id", user.id);
    setBoards((prev) => prev.map((b) => (b.id === board.id ? { ...b, title: name } : b)));
  };

  const handleDeleteBoard = async (board: BoardEntry) => {
    if (!user?.id) return;
    const ok = window.confirm("Delete this board? This cannot be undone.");
    if (!ok) return;
    await supabase.from("omnia_board_states").delete().eq("board_id", board.id);
    await supabase.from("omnia_boards").delete().eq("id", board.id).eq("user_id", user.id);
    setBoards((prev) => prev.filter((b) => b.id !== board.id));
  };

  const handleMoveBoard = async (boardId: string, targetProjectId: string) => {
    if (!user?.id || !projectId) return;
    await supabase
      .from("omnia_boards")
      .update({ project_id: targetProjectId })
      .eq("id", boardId)
      .eq("user_id", user.id);
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    setMoveBoardId(null);
  };

  const getPointerPercent = (event: React.PointerEvent) => {
    if (!mapRef.current) return null;
    const rect = mapRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left - panOffset.x) / rect.width) * 100;
    const y = ((event.clientY - rect.top - panOffset.y) / rect.height) * 100;
    return {
      x: Math.max(2, Math.min(98, x)),
      y: Math.max(2, Math.min(98, y)),
    };
  };

  const handleMapPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    lastPanRef.current = { x: event.clientX - panOffset.x, y: event.clientY - panOffset.y };
  };

  const handleMapPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (lastPanRef.current) {
      setPanOffset({
        x: event.clientX - lastPanRef.current.x,
        y: event.clientY - lastPanRef.current.y,
      });
    }
    if (mapRef.current) {
      const rect = mapRef.current.getBoundingClientRect();
      const relX = (event.clientX - rect.left) / rect.width - 0.5;
      const relY = (event.clientY - rect.top) / rect.height - 0.5;
      setTilt({ x: relY * 6, y: relX * 6 });
    }
  };

  const handleMapPointerUp = () => {
    lastPanRef.current = null;
  };

  const commitProjectTitle = async () => {
    const next = draftTitle.trim();
    if (!next || !projectId) {
      setDraftTitle(projectName);
      setIsEditingTitle(false);
      return;
    }
    if (next === projectName) {
      setIsEditingTitle(false);
      return;
    }
    await supabase.from("omnia_projects").update({ name: next }).eq("id", projectId);
    setProjectName(next);
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
    setIsEditingTitle(false);
  };

  const handleDropFiles = (fileEntries: FileEntry[]) => {
    setFiles((prev) => [...fileEntries, ...prev]);
  };

  const handleDeleteFile = (fileId: string) => {
    const ok = window.confirm("Delete this file?");
    if (!ok) return;
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
    setOpenFileMenuId(null);
  };

  const handleRenameFile = (file: FileEntry) => {
    const next = window.prompt("Rename file", file.name);
    if (!next || !next.trim()) return;
    setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, name: next.trim() } : f)));
    setOpenFileMenuId(null);
  };

  const classifyFile = (file: File) => {
    const name = file.name.toLowerCase();
    if (name.match(/\.(png|jpe?g|webp|gif|svg|bmp|ico|tiff?|avif|heic|heif)$/)) return "image";
    if (name.match(/\.(mp4|mov|webm|m4v|avi|mkv|flv|3gp|ogv)$/)) return "video";
    if (name.match(/\.(mp3|wav|ogg|flac|aac|m4a|wma)$/)) return "audio";
    if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    if (name.match(/\.docx?$/)) return "doc";
    if (name.match(/\.pptx?$/)) return "doc";
    if (name.match(/\.xlsx?$/)) return "spreadsheet";
    if (name.match(/\.xls$/)) return "spreadsheet";
    if (name.match(/\.(csv|tsv)$/)) return "spreadsheet";
    if (name.match(/\.(txt|rtf|md|json|xml|html|css|js|ts|py|rb|java|c|cpp|h|rs|go|sh)$/)) return "doc";
    return "file";
  };

  const uploadFileToStorage = async (file: File, targetFolderId: string | null): Promise<FileEntry | null> => {
    if (!user?.id) return null;
    const kind = classifyFile(file);

    // Convert HEIF to JPEG before upload so images render in all browsers
    let fileToUpload = file;
    if (kind === "image") {
      try {
        const { fileToDisplayableFile } = await import("@/lib/heifToJpeg");
        fileToUpload = await fileToDisplayableFile(file);
      } catch (e) {
        console.warn("[ProjectPlaceholder] HEIF conversion skipped:", e);
      }
    }

    const fileId = crypto.randomUUID();
    const fileExt = fileToUpload.name.split(".").pop() || "bin";
    const storagePath = `${user.id}/${fileId}/original.${fileExt}`;
    const storageBucket = "user-files";

    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, fileToUpload, { cacheControl: "3600", upsert: false });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return null;
    }

    let spreadsheetData: SpreadsheetData | undefined;
    if (kind === "spreadsheet") {
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`${API_BASE_URL}/api/files/parse-spreadsheet`, { method: "POST", body: formData });
        if (res.ok) {
          const data = await res.json();
          if (data.rows != null && data.cols != null && data.cells) {
            spreadsheetData = { rows: data.rows, cols: data.cols, cells: data.cells };
          }
        }
      } catch {
        // leave spreadsheetData undefined; card will show fallback
      }
    }

    let fileUrl = "";
    const { data: signedData } = await supabase.storage
      .from(storageBucket)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
    if (signedData?.signedUrl) {
      fileUrl = signedData.signedUrl;
      signedUrlCacheRef.current.set(`${storageBucket}:${storagePath}`, fileUrl);
    } else {
      const { data: urlData } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);
      fileUrl = urlData?.publicUrl || "";
    }

    return {
      id: `file-${Date.now()}-${Math.random()}`,
      name: file.name,
      path: file.name,
      folderId: targetFolderId,
      kind,
      url: fileUrl,
      storagePath,
      storageBucket,
      size: fileToUpload.size,
      ...(spreadsheetData ? { spreadsheetData } : {}),
    };
  };

  const traverseEntryFiles = (entry: any, currentPath: string, out: File[]) =>
    new Promise<void>((resolve) => {
      if (entry.isFile) {
        entry.file((file: File) => {
          out.push(file);
          resolve();
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        reader.readEntries(async (entries: any[]) => {
          for (const child of entries) {
            await traverseEntryFiles(child, `${currentPath}${entry.name}/`, out);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });

  const collectDropEntries = async (event: React.DragEvent, targetFolderId: string | null) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);

    const items = Array.from(event.dataTransfer.items || []);
    const fileEntries: FileEntry[] = [];

    const urlText =
      event.dataTransfer.getData("text/uri-list") ||
      event.dataTransfer.getData("text/plain") ||
      "";
    if (urlText && /^https?:\/\//i.test(urlText)) {
      fileEntries.push({
        id: `file-${Date.now()}-${Math.random()}`,
        name: urlText,
        path: urlText,
        folderId: targetFolderId,
        kind: "link",
        url: urlText,
      });
    }

    const rawFiles: File[] = [];
    const tasks: Promise<void>[] = [];
    for (const item of items) {
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry) {
        tasks.push(traverseEntryFiles(entry, "", rawFiles));
      } else {
        const file = item.getAsFile?.();
        if (file) rawFiles.push(file);
      }
    }
    await Promise.all(tasks);

    for (const file of rawFiles) {
      const uploaded = await uploadFileToStorage(file, targetFolderId);
      if (uploaded) {
        fileEntries.push(uploaded);
        setResolvedUrls((prev) => ({ ...prev, [uploaded.id]: uploaded.url }));
      }
    }

    if (fileEntries.length) handleDropFiles(fileEntries);
  };

  const memoryToFileEntry = (payload: any): FileEntry[] => {
    const entries: FileEntry[] = [];
    const title = String(payload.title || "Memory").trim();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

    if (attachments.length > 0) {
      for (const att of attachments) {
        const url = String(att?.url || "").trim();
        const attType = String(att?.type || "").toLowerCase();
        const name = String(att?.name || att?.title || title || url).trim();
        let kind: FileEntry["kind"] = "file";
        if (attType === "youtube" || attType === "link") kind = "link";
        else if (["image", "png", "jpg", "jpeg", "webp", "gif"].includes(attType)) kind = "image";
        else if (["video", "mp4", "mov", "webm"].includes(attType)) kind = "video";
        else if (["audio", "mp3", "wav"].includes(attType)) kind = "audio";
        else if (attType === "pdf") kind = "pdf";
        else if (["doc", "document"].includes(attType)) kind = "doc";
        else if (attType === "spreadsheet" || (att.rows != null && att.cols != null && att.cells)) kind = "spreadsheet";
        else if (url && /youtube\.com|youtu\.be/i.test(url)) kind = "link";
        else if (url && /\.(png|jpe?g|webp|gif|svg|heic|heif)$/i.test(url)) kind = "image";
        else if (url && /\.(mp4|mov|webm)$/i.test(url)) kind = "video";
        else if (url && /\.pdf$/i.test(url)) kind = "pdf";

        entries.push({
          id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name,
          path: url || name,
          folderId: activeFolderId,
          kind,
          url,
          ...(att?.storagePath ? { storagePath: att.storagePath, storageBucket: att.storageBucket || "user-files" } : {}),
          ...(kind === "spreadsheet" && att?.rows != null && att?.cols != null && att?.cells
            ? { spreadsheetData: { rows: att.rows, cols: att.cols, cells: att.cells } }
            : {}),
        });
      }
    } else if (payload.content) {
      entries.push({
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: title,
        path: title,
        folderId: activeFolderId,
        kind: "doc",
        url: "",
        content: String(payload.content).trim(),
      });
    }
    return entries;
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    const win = window as any;

    // Check for cross-iframe pending memory (from embedded memory sidebar)
    if (win.__omnia_pending_memory) {
      const entries = memoryToFileEntry(win.__omnia_pending_memory);
      win.__omnia_pending_memory = null;
      if (entries.length > 0) {
        event.preventDefault();
        dragDepthRef.current = 0;
        setIsDragging(false);
        handleDropFiles(entries);
        return;
      }
    }

    // Check for MIME-based memory drag
    const omniaRaw = event.dataTransfer.getData("application/x-omnia-memory") || "";
    if (omniaRaw) {
      try {
        const entries = memoryToFileEntry(JSON.parse(omniaRaw));
        if (entries.length > 0) {
          event.preventDefault();
          dragDepthRef.current = 0;
          setIsDragging(false);
          handleDropFiles(entries);
          return;
        }
      } catch { /* fall through */ }
    }

    // Legacy memory MIME
    const legacyRaw = event.dataTransfer.getData("application/x-lykins-memory-card") || "";
    if (legacyRaw) {
      try {
        const entries = memoryToFileEntry(JSON.parse(legacyRaw));
        if (entries.length > 0) {
          event.preventDefault();
          dragDepthRef.current = 0;
          setIsDragging(false);
          handleDropFiles(entries);
          return;
        }
      } catch { /* fall through */ }
    }

    await collectDropEntries(event, activeFolderId);
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputFiles = e.target.files;
    if (!inputFiles || inputFiles.length === 0) return;
    const newEntries: FileEntry[] = [];
    for (const file of Array.from(inputFiles)) {
      const uploaded = await uploadFileToStorage(file, activeFolderId);
      if (uploaded) newEntries.push(uploaded);
    }
    if (newEntries.length > 0) handleDropFiles(newEntries);
    e.target.value = "";
  };

  const renderFilePreview = (file: FileEntry) => {
    const lower = file.name.toLowerCase();
    const isImage = file.kind === "image" || /\.(png|jpe?g|webp|gif|svg|bmp|ico|tiff?|avif|heic|heif)$/i.test(lower);
    const isVideo = file.kind === "video" || /\.(mp4|mov|webm|m4v|avi|mkv|flv|3gp|ogv)$/i.test(lower);
    const isAudio = file.kind === "audio" || /\.(mp3|wav|ogg|flac|aac|m4a|wma)$/i.test(lower);
    const isPdf = file.kind === "pdf" || /\.pdf$/i.test(lower);
    const displayUrl = resolvedUrls[file.id] || file.url;

    const noPreview = (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <FileIcon className="w-10 h-10 text-black/30" />
        <p className="text-sm text-black/60">{file.name}</p>
        <p className="text-xs text-black/40">Preview not available.{displayUrl ? " Click download to view." : ""}</p>
        {displayUrl && (
          <a href={displayUrl} download={file.name} className="text-xs text-blue-600 underline mt-1">
            Download file
          </a>
        )}
      </div>
    );

    if (!displayUrl && file.kind !== "link") return noPreview;

    if (isImage) {
      return <img src={displayUrl} alt={file.name} className="max-h-[60vh] w-full object-contain rounded-lg" />;
    }
    if (isVideo) {
      return <video src={displayUrl} controls className="w-full max-h-[60vh] rounded-lg bg-black/5" />;
    }
    if (isAudio) {
      return (
        <div className="flex flex-col items-center gap-4 py-8">
          <Music className="w-12 h-12 text-violet-400/70" />
          <audio src={displayUrl} controls className="w-full max-w-md" />
        </div>
      );
    }
    if (isPdf) {
      return (
        <iframe
          title={file.name}
          src={displayUrl}
          className="w-full h-[60vh] rounded-lg border border-white/40 bg-white/60"
        />
      );
    }
    if (file.kind === "link" && /youtube\.com|youtu\.be/i.test(file.url)) {
      const videoId = extractYouTubeVideoId(file.url);
      const embedUrl = videoId ? getYouTubeEmbedUrl(videoId) : "";
      if (embedUrl) {
        return (
          <iframe
            title="YouTube"
            src={embedUrl}
            className="w-full h-[60vh] rounded-lg border border-white/40 bg-white/60"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        );
      }
      return (
        <div className="text-sm text-black/70">
          <a href={file.url} target="_blank" rel="noreferrer" className="underline">Open YouTube link</a>
        </div>
      );
    }
    if (file.kind === "link") {
      return (
        <div className="flex flex-col items-center gap-3 py-6">
          <Link2 className="w-10 h-10 text-blue-400/70" />
          <a href={file.url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline break-all">
            {file.url}
          </a>
        </div>
      );
    }
    return noPreview;
  };

  const updateSelectedModel = (value: string) => {
    setSelectedModel(value);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiModel = value;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
    } catch { /* ignore */ }
  };

  const handleSaveQuickNote = async () => {
    if (!user?.id || isQuickNoteSaving) return;
    const content = quickNoteContent.trim();
    if (!content) return;
    setIsQuickNoteSaving(true);
    try {
      await supabase.from("notes").insert({
        user_id: user.id,
        title: quickNoteTitle.trim() || "Quick Note",
        content,
      });
      setQuickNoteTitle("");
      setQuickNoteContent("");
      setShowQuickNote(false);
    } catch {
      // Keep open on failure
    } finally {
      setIsQuickNoteSaving(false);
    }
  };

  const handleChatSend = async () => {
    if (!chatInput.trim() || isChatLoading) return;
    const userMessage = { role: "user", content: chatInput };
    setChatMessages((prev) => [...prev, userMessage]);
    setChatInput("");
    setIsChatLoading(true);

    const assistantMessageIndex = chatMessages.length + 1;
    setChatMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const settings = JSON.parse(localStorage.getItem("lykinsai_settings") || "{}");
      const personality = settings.aiPersonality || "balanced";
      const detailLevel = settings.aiDetailLevel || "medium";

      const personalityStyles = {
        professional: "You are a professional writing assistant. Be formal, precise, and objective.",
        balanced: "You are a helpful AI assistant. Be friendly yet professional.",
        casual: "You are a friendly companion. Be warm, conversational, and supportive.",
        enthusiastic: "You are an enthusiastic creative coach. Be energetic, motivating, and positive!",
      };

      const detailStyles = {
        brief: "Keep responses concise and under 3 sentences.",
        medium: "Provide clear responses with moderate detail.",
        detailed: "Give comprehensive, detailed responses with examples and explanations.",
      };

      const notesContext = allNotes
        .slice(0, 20)
        .map((n) => {
          const summary = summarizeNoteContentForAI(n.content || "");
          return `ID: ${n.id}\nTitle: ${n.title}\nBlocks:\n${summary}\nDate: ${n.created_at || n.created_date || "N/A"}`;
        })
        .join("\n\n---\n\n");

      const history = chatMessages.map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`).join("\n");

      const prompt = `${personalityStyles[personality]} ${detailStyles[detailLevel]}

You are helping the user brainstorm and develop their idea. Here's what they're working on:

Project: ${projectName}
Active folder: ${activeFolderId || "None"}

Conversation History:
${history}

User's recent memories:
${notesContext}

User's Current Question: ${chatInput}

If the user asks about old memories or references past ideas, refer to the memories above. When referencing a specific memory, you MUST wrap the exact note title in double brackets like this: [[Note Title]]. For example, if there's a note titled "Project Ideas for AI App", you would write [[Project Ideas for AI App]]. This makes it clickable. Always use the exact title from the memories list above. Provide helpful guidance, suggestions, or answers to help develop this idea. Do not use emojis unless explicitly asked.`;

      const { API_BASE_URL } = await import("@/lib/api-config");
      const aiResponse = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, prompt, ...getAiPrefs() }),
      });

      if (!aiResponse.ok) {
        let errorMessage = aiResponse.statusText;
        try {
          const errorData = await aiResponse.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch {
          // ignore
        }
        throw new Error(`AI API error: ${errorMessage}`);
      }

      const responseData = await aiResponse.json();
      const aiText = responseData.response || responseData.content || "";
      if (!aiText) {
        throw new Error("No response from AI. Please check your API keys and try again.");
      }

      const words = aiText.split(" ");
      let currentText = "";

      for (let i = 0; i < words.length; i += 1) {
        currentText += (i === 0 ? "" : " ") + words[i];
        setChatMessages((prev) => {
          const newMessages = [...prev];
          newMessages[assistantMessageIndex] = { role: "assistant", content: currentText, notes: allNotes };
          return newMessages;
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    } catch (error: any) {
      setChatMessages((prev) => {
        const newMessages = [...prev];
        newMessages[assistantMessageIndex] = { role: "assistant", content: "Sorry, I encountered an error." };
        return newMessages;
      });
    } finally {
      setIsChatLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen bg-transparent text-black relative"
      onDragEnter={(e) => {
        e.preventDefault();
        if (draggedFileId) return;
        dragDepthRef.current += 1;
        setIsDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        if (draggedFileId) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      <header className="fixed top-0 left-0 right-0 z-30 bg-white/60 backdrop-blur-md">
        <div className="mx-auto w-full max-w-[100rem] px-3 sm:px-6 py-3 sm:py-4 flex items-center">
          <div className="hidden md:block w-[13rem] lg:w-[17.5rem] xl:w-[21.25rem] shrink-0" />
          <div className="text-base sm:text-lg font-semibold shrink-0">
            {isEditingTitle ? (
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={commitProjectTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                  if (e.key === "Escape") {
                    setDraftTitle(projectName);
                    setIsEditingTitle(false);
                  }
                }}
                autoFocus
                className="w-full max-w-[17.5rem] sm:max-w-[26.25rem] bg-white/70 border border-white/60 rounded-lg px-3 py-1 text-base sm:text-lg font-semibold outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraftTitle(projectName);
                  setIsEditingTitle(true);
                }}
                className="rounded-lg px-2 py-1 hover:bg-white/40 transition-colors"
                title="Rename project"
              >
                {projectName}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Top Panel */}
      <div
        className="fixed top-3 left-0 z-[70] px-3 flex items-center justify-end pointer-events-none transition-all duration-300"
        style={{ right: "0px" }}
      >
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTopPanelOpen((v) => !v)}
            className="rounded-full w-9 h-9 hover:bg-black/10 transition-colors touch-manipulation flex items-center justify-center"
            title={topPanelOpen ? "Hide panel" : "Show panel"}
          >
            {topPanelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span className="sr-only">{topPanelOpen ? "Hide panel" : "Show panel"}</span>
          </button>

          {topPanelOpen && (
            <div className="flex items-center gap-1 p-1 rounded-full glass-control flex-wrap">
              <button
                type="button"
                onClick={() => nav(-1)}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 transition-colors touch-manipulation flex items-center justify-center"
                title="Back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 mx-1" />

              <Select value={selectedModel} onValueChange={updateSelectedModel}>
                <SelectTrigger className="w-[6.25rem] sm:w-[8.125rem] h-9 rounded-full glass-control hover:opacity-90 text-xs font-medium">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  className="glass-control border border-white/25 bg-white/35 backdrop-blur-xl shadow-lg overflow-hidden"
                >
                  <SelectGroup>
                    <SelectLabel>Latest</SelectLabel>
                    <SelectItem value="claude-opus-4-6" hint="Anthropic flagship">Claude Opus 4.6</SelectItem>
                    <SelectItem value="gpt-5.4" hint="OpenAI flagship">GPT-5.4</SelectItem>
                    <SelectItem value="gemini-3.1-pro-preview" hint="Google flagship">Gemini 3.1 Pro</SelectItem>
                    <SelectItem value="grok-4-1-fast-reasoning" hint="xAI flagship">Grok 4.1 Fast Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Fastest</SelectLabel>
                    <SelectItem value="gemini-3-flash-preview" hint="Google, ultra-fast">Gemini 3 Flash</SelectItem>
                    <SelectItem value="gemini-3.1-flash-lite-preview" hint="Google, cheapest">Gemini 3.1 Flash-Lite</SelectItem>
                    <SelectItem value="gemini-2.5-flash" hint="Google, balanced">Gemini 2.5 Flash</SelectItem>
                    <SelectItem value="gpt-4.1-nano" hint="OpenAI, smallest">GPT-4.1 Nano</SelectItem>
                    <SelectItem value="gpt-4.1-mini" hint="OpenAI, fast + smart">GPT-4.1 Mini</SelectItem>
                    <SelectItem value="gpt-5-mini" hint="OpenAI, near-frontier">GPT-5 Mini</SelectItem>
                    <SelectItem value="claude-haiku-4-5-20251001" hint="Anthropic, fast">Claude Haiku 4.5</SelectItem>
                    <SelectItem value="grok-4-1-fast-non-reasoning" hint="xAI, low latency">Grok 4.1 Fast Non-Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Cheap</SelectLabel>
                    <SelectItem value="gpt-4o-mini" hint="OpenAI, budget">GPT-4o Mini</SelectItem>
                    <SelectItem value="o4-mini" hint="OpenAI, cheap reasoning">o4 Mini</SelectItem>
                    <SelectItem value="grok-3-mini" hint="xAI, budget">Grok 3 Mini</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Image & Video Gen</SelectLabel>
                    <SelectItem value="gpt-image-1.5" hint="OpenAI, images">GPT Image 1.5</SelectItem>
                    <SelectItem value="gemini-3.1-flash-image-preview" hint="Google, images">Nano Banana 2</SelectItem>
                    <SelectItem value="grok-imagine-image-pro" hint="xAI, pro images">Grok Imagine Image Pro</SelectItem>
                    <SelectItem value="grok-imagine-image" hint="xAI, images">Grok Imagine Image</SelectItem>
                    <SelectItem value="grok-2-image-1212" hint="xAI, images">Grok 2 Image</SelectItem>
                    <SelectItem value="dall-e-3" hint="OpenAI, images">DALL-E 3</SelectItem>
                    <SelectItem value="veo-3.1-generate-preview" hint="Google, video">Veo 3.1</SelectItem>
                    <SelectItem value="grok-imagine-video" hint="xAI, video">Grok Imagine Video</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Deep Thinking</SelectLabel>
                    <SelectItem value="o3" hint="OpenAI, reasoning">o3</SelectItem>
                    <SelectItem value="o3-pro" hint="OpenAI, max reasoning">o3 Pro</SelectItem>
                    <SelectItem value="gpt-5.4-pro" hint="OpenAI, extended">GPT-5.4 Pro</SelectItem>
                    <SelectItem value="claude-opus-4-1-20250805" hint="Anthropic, deep">Claude Opus 4.1</SelectItem>
                    <SelectItem value="claude-opus-4-20250514" hint="Anthropic, deep">Claude Opus 4</SelectItem>
                    <SelectItem value="gemini-2.5-pro" hint="Google, reasoning">Gemini 2.5 Pro</SelectItem>
                    <SelectItem value="grok-4-fast-reasoning" hint="xAI, reasoning">Grok 4 Fast Reasoning</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Code</SelectLabel>
                    <SelectItem value="claude-opus-4-6-code" hint="Anthropic, top coder">Claude Opus 4.6</SelectItem>
                    <SelectItem value="claude-sonnet-4-6" hint="Anthropic, fast coder">Claude Sonnet 4.6</SelectItem>
                    <SelectItem value="gpt-5.3-codex" hint="OpenAI, agentic code">Codex 5.3</SelectItem>
                    <SelectItem value="gpt-4.1" hint="OpenAI, 1M ctx code">GPT-4.1</SelectItem>
                    <SelectItem value="grok-code-fast-1" hint="xAI, code">Grok Code Fast 1</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>General</SelectLabel>
                    <SelectItem value="gpt-5.2" hint="OpenAI, previous gen">GPT-5.2</SelectItem>
                    <SelectItem value="gpt-5.1" hint="OpenAI, previous gen">GPT-5.1</SelectItem>
                    <SelectItem value="gpt-5" hint="OpenAI, previous gen">GPT-5</SelectItem>
                    <SelectItem value="gpt-4o" hint="OpenAI, versatile">GPT-4o</SelectItem>
                    <SelectItem value="claude-sonnet-4-20250514" hint="Anthropic, balanced">Claude Sonnet 4</SelectItem>
                    <SelectItem value="grok-4-fast-non-reasoning" hint="xAI, general">Grok 4 Fast Non-Reasoning</SelectItem>
                    <SelectItem value="grok-4-0709" hint="xAI, general">Grok 4 0709</SelectItem>
                    <SelectItem value="grok-3" hint="xAI, previous gen">Grok 3</SelectItem>
                    <SelectItem value="grok-2-vision-1212" hint="xAI, vision">Grok 2 Vision</SelectItem>
                    <SelectItem value="unified-auto" hint="Auto-picks best">Unified AI (Auto)</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>

              <div className="w-px h-4 bg-black/10 mx-1" />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 transition-colors touch-manipulation flex items-center justify-center"
                title="Add attachments"
              >
                <Plus className="w-4 h-4" />
              </button>

              <div className="w-px h-4 bg-black/10 mx-1" />

              <button
                type="button"
                onClick={() => setShowMemorySidebar((v) => !v)}
                className="rounded-full w-9 h-9 p-0 hover:bg-black/10 transition-colors touch-manipulation flex items-center justify-center"
                title={showMemorySidebar ? "Hide media sidebar" : "Open media sidebar"}
              >
                {showMemorySidebar ? <PanelRightClose className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
              </button>
            </div>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-[100rem] px-3 sm:px-6 pt-28 pb-16 grid grid-cols-1 md:grid-cols-[13rem_1fr] lg:grid-cols-[17.5rem_1fr] xl:grid-cols-[21.25rem_1fr_17.5rem] gap-3">
        {/* Left: File Collage */}
        <div className="space-y-5">
        <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-3 sm:p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">All Files</h2>
            <span className="text-[0.6875rem] text-black/50">{allFilesForCollage.length} file{allFilesForCollage.length !== 1 ? "s" : ""}</span>
          </div>
          {allFilesForCollage.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-white/40 border border-white/50 flex items-center justify-center mb-3">
                <ImageIcon className="w-7 h-7 text-black/30" />
              </div>
              <p className="text-sm text-black/50">No files yet</p>
              <p className="text-xs text-black/40 mt-1">Drop files anywhere to add them</p>
            </div>
          ) : (
            <div className="columns-1 lg:columns-2 gap-4">
              {allFilesForCollage.map((file) => {
                const lower = file.name.toLowerCase();
                const isImage = file.kind === "image" || /\.(png|jpe?g|webp|gif|svg|bmp|ico|tiff?|avif|heic|heif)$/i.test(lower);
                const isVideo = file.kind === "video" || /\.(mp4|mov|webm|m4v|avi|mkv|flv|3gp|ogv)$/i.test(lower);
                const isAudio = file.kind === "audio" || /\.(mp3|wav|ogg|flac|aac|m4a|wma)$/i.test(lower);
                const isPdf = file.kind === "pdf" || /\.pdf$/i.test(lower);
                const isLink = file.kind === "link";
                const isYouTube = isLink && /youtube\.com|youtu\.be/i.test(file.url);
                const displayUrl = resolvedUrls[file.id] || file.url;

                const fallbackCard = (icon: React.ReactNode, label: string, subtitle?: string) => (
                  <div className="glass-control rounded-2xl p-4" draggable={false}>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-white/50 border border-white/60 flex items-center justify-center shrink-0">
                        {icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-black/85 truncate">{label}</p>
                        {subtitle && <p className="text-[0.6875rem] text-black/55 mt-0.5 truncate">{subtitle}</p>}
                      </div>
                    </div>
                  </div>
                );

                const renderMediaContent = () => {
                  if (isImage) {
                    if (!displayUrl) return fallbackCard(<ImageIcon className="w-5 h-5 text-black/40" />, file.name, "Image");
                    return (
                      <div className="relative">
                        <img
                          src={displayUrl}
                          alt={file.name}
                          className="w-full h-auto max-h-[42rem] rounded-2xl bg-white/30"
                          loading="lazy"
                          draggable={false}
                          onError={(e) => {
                            const target = e.currentTarget;
                            target.style.display = "none";
                            const fb = target.parentElement?.querySelector("[data-fallback]") as HTMLElement;
                            if (fb) fb.style.display = "";
                          }}
                        />
                        <div data-fallback="" style={{ display: "none" }}>
                          {fallbackCard(<ImageIcon className="w-5 h-5 text-black/40" />, file.name, "Image")}
                        </div>
                      </div>
                    );
                  }

                  if (isYouTube) {
                    const videoId = extractYouTubeVideoId(file.url);
                    const embedUrl = videoId ? getYouTubeEmbedUrl(videoId) : "";
                    if (embedUrl) {
                      return (
                        <div className="w-full rounded-2xl overflow-hidden bg-black" draggable={false}>
                          <iframe
                            src={embedUrl}
                            title={file.name}
                            className="w-full h-44 border-0"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                            allowFullScreen
                          />
                        </div>
                      );
                    }
                    return fallbackCard(<Video className="w-5 h-5 text-red-500/70" />, file.name, "YouTube Video");
                  }

                  if (isVideo) {
                    if (!displayUrl) return fallbackCard(<Video className="w-5 h-5 text-black/40" />, file.name, "Video");
                    return (
                      <video
                        src={displayUrl}
                        className="w-full h-auto max-h-[42rem] rounded-2xl bg-black/5"
                        controls
                        preload="metadata"
                        draggable={false}
                      />
                    );
                  }

                  if (isAudio) {
                    return (
                      <div className="glass-control rounded-2xl p-3 space-y-3">
                        <div className="flex items-center gap-2 text-black/80">
                          <Music className="w-4 h-4" />
                          <span className="text-xs font-medium truncate">{file.name}</span>
                        </div>
                        {displayUrl ? (
                          <audio src={displayUrl} controls className="w-full h-10" preload="metadata" />
                        ) : (
                          <p className="text-[0.6875rem] text-black/50">Audio file</p>
                        )}
                      </div>
                    );
                  }

                  if (isPdf) {
                    if (displayUrl) {
                      return (
                        <div className="w-full h-80 rounded-2xl overflow-hidden bg-white/40 border border-white/50">
                          <iframe
                            src={displayUrl}
                            title={file.name}
                            className="w-full h-full border-0"
                            draggable={false}
                          />
                        </div>
                      );
                    }
                    return fallbackCard(<FileText className="w-5 h-5 text-red-400/70" />, file.name, "PDF");
                  }

                  if (isLink) {
                    let domain = "";
                    try { domain = new URL(file.url).hostname.replace("www.", ""); } catch { /* ignore */ }
                    return fallbackCard(
                      <Link2 className="w-5 h-5 text-blue-400/70" />,
                      file.name,
                      domain || file.url || "Link"
                    );
                  }

                  if (file.kind === "doc") {
                    if (file.content) {
                      return (
                        <div className="glass-control rounded-2xl p-4" draggable={false}>
                          <div className="flex items-center gap-2 text-black/70 mb-2">
                            <StickyNote className="w-4 h-4" />
                            <span className="text-xs font-medium">Quick Note</span>
                          </div>
                          <div className="max-h-56 overflow-y-auto scrollbar-hide">
                            <p className="text-sm text-black/70 whitespace-pre-wrap break-words">{file.content}</p>
                          </div>
                          <div className="mt-3 text-[0.6875rem] text-black/55 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{file.name}</span>
                          </div>
                        </div>
                      );
                    }
                    return fallbackCard(
                      <FileText className="w-5 h-5 text-blue-400/70" />,
                      file.name,
                      `${lower.split(".").pop()?.toUpperCase()} file`
                    );
                  }

                  if (file.kind === "spreadsheet" && file.spreadsheetData) {
                    const { rows, cols, cells } = file.spreadsheetData;
                    return (
                      <div className="glass-control rounded-2xl overflow-hidden" draggable={false}>
                        <div className="flex items-center gap-2 text-black/70 px-3 py-2 border-b border-black/10">
                          <Table className="w-4 h-4" />
                          <span className="text-xs font-medium truncate">{file.name}</span>
                        </div>
                        <div className="max-h-[28rem] overflow-auto scrollbar-thin">
                          <table className="w-full border-collapse text-[0.6875rem]">
                            <tbody>
                              {Array.from({ length: rows }, (_, r) => (
                                <tr key={r}>
                                  {Array.from({ length: cols }, (_, c) => (
                                    <td
                                      key={c}
                                      className="border border-black/15 px-2 py-1.5 align-top bg-white/50 min-w-[4rem] max-w-[14rem] break-words"
                                      title={cells[`${r},${c}`]}
                                    >
                                      {cells[`${r},${c}`] ?? "\u00A0"}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  }

                  if (file.kind === "spreadsheet") {
                    return fallbackCard(
                      <Table className="w-5 h-5 text-blue-400/70" />,
                      file.name,
                      "Spreadsheet (loading…)"
                    );
                  }

                  return fallbackCard(
                    <FileIcon className="w-5 h-5 text-black/40" />,
                    file.name,
                    "File"
                  );
                };

                return (
                  <article
                    key={file.id}
                    className={`break-inside-avoid mb-5 rounded-2xl relative overflow-visible cursor-grab ${
                      openFileMenuId === file.id ? "z-[120]" : "z-0"
                    }`}
                    draggable
                    onDragStart={(e) => {
                      setDraggedFileId(file.id);
                      e.dataTransfer.setData("text/plain", file.id);
                    }}
                    onDragEnd={() => setDraggedFileId(null)}
                  >
                    <div
                      className="cursor-pointer"
                      onClick={() => setSelectedFile(file)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter") setSelectedFile(file); }}
                    >
                      {renderMediaContent()}
                    </div>

                    {/* 3-dot menu — same as Memory page */}
                    <div className="mt-2 flex justify-end px-1">
                      <div className="relative" ref={openFileMenuId === file.id ? fileMenuRef : null}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenFileMenuId((prev) => (prev === file.id ? null : file.id));
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="px-1 py-0.5 text-black/75 hover:text-black leading-none text-base font-semibold"
                          title="File actions"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                        {openFileMenuId === file.id && (
                          <div
                            className="absolute right-0 bottom-full mb-2 w-48 rounded-2xl border border-white/60 bg-white/85 backdrop-blur-xl shadow-2xl p-2 z-[130]"
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRenameFile(file);
                              }}
                              className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 flex items-center gap-2"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                              Rename
                            </button>
                            {file.url && (
                              <a
                                href={file.url}
                                download={file.name}
                                onClick={() => setOpenFileMenuId(null)}
                                className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 flex items-center gap-2"
                              >
                                <Download className="w-3.5 h-3.5" />
                                Download
                              </a>
                            )}
                            <div className="my-1 h-px bg-black/10" />
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteFile(file.id);
                              }}
                              className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 flex items-center gap-2 text-red-600"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        </div>

        {/* Center: Boards, Connections */}
        <div className="min-w-0 space-y-6">
          <div className="w-full flex items-center gap-2 rounded-xl border border-white/60 bg-white/70 backdrop-blur-md px-3 sm:px-4 py-2 text-[0.75rem] text-black/70">
            <SearchIcon className="w-4 h-4" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search boards"
              className="w-full bg-transparent outline-none placeholder:text-black/40"
            />
          </div>

          {/* Boards */}
          <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-3 sm:p-4 lg:p-6 overflow-visible relative z-10">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-semibold">Boards</h2>
                <p className="text-[0.6875rem] sm:text-xs text-black/60">
                  Create and organize boards inside this project.
                </p>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2 overflow-visible relative z-10">
              <button
                type="button"
                onClick={handleCreateBoard}
                className="rounded-xl border-2 border-dashed border-black/15 bg-white/30 hover:bg-white/50 hover:border-black/25 backdrop-blur-md p-4 flex flex-col items-center justify-center gap-2 transition-all h-[88px]"
              >
                <div className="w-9 h-9 rounded-lg bg-white/60 border border-white/70 flex items-center justify-center">
                  <Plus className="w-5 h-5 text-black/50" />
                </div>
                <span className="text-xs font-medium text-black/60">Create new board</span>
              </button>

              {filteredBoards.map((board) => (
                <div key={board.id} className={`relative group ${openBoardMenuId === board.id ? "z-50" : ""}`}>
                  <button
                    type="button"
                    onClick={() => {
                      localStorage.setItem("omnia_board_id", board.id);
                      nav(`/canvas/${board.id}`);
                    }}
                    className="w-full h-[88px] rounded-xl border border-white/60 bg-white/50 hover:bg-white/70 backdrop-blur-md p-4 shadow-lg text-left transition-all flex flex-col justify-center"
                  >
                    <div className="text-sm font-semibold truncate">{board.title}</div>
                    <div className="mt-1 text-xs text-black/50">Board</div>
                  </button>
                  <div className="absolute top-2 right-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="relative" ref={openBoardMenuId === board.id ? boardMenuRef : null}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenBoardMenuId((prev) => (prev === board.id ? null : board.id));
                        }}
                        className="px-1 py-0.5 text-black/60 hover:text-black transition-colors"
                        aria-label="Board actions"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                      {openBoardMenuId === board.id && (
                        <div className="absolute right-0 mt-2 w-48 rounded-xl border border-white/60 bg-white/80 backdrop-blur-md shadow-xl p-2 z-50">
                          <button
                            type="button"
                            onClick={() => {
                              handleRenameBoard(board);
                              setOpenBoardMenuId(null);
                            }}
                            className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5"
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMoveBoardId(board.id);
                              setOpenBoardMenuId(null);
                            }}
                            className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5"
                          >
                            Move to project
                          </button>
                          <button
                            type="button"
                            className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5"
                          >
                            Add team members
                          </button>
                          <div className="my-1 h-px bg-black/10" />
                          <button
                            type="button"
                            onClick={() => {
                              handleDeleteBoard(board);
                              setOpenBoardMenuId(null);
                            }}
                            className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5 text-red-600"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Connections / Graph */}
          <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-3 sm:p-4 lg:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-semibold">{bottomTab === "connections" ? "Connections" : "Graph"}</h2>
                <p className="text-[0.6875rem] sm:text-xs text-black/60">
                  {bottomTab === "connections"
                    ? "Boards and their files in this project."
                    : "Visual graph of boards and files in this project."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {bottomTab === "connections" && (
                  <div className="hidden sm:block rounded-full border border-white/60 bg-white/60 px-3 py-1 text-[0.6875rem] text-black/60">
                    {boards.length} board{boards.length !== 1 ? "s" : ""} · {files.length} file{files.length !== 1 ? "s" : ""}
                  </div>
                )}
                <div className="inline-flex items-center gap-1 p-1 rounded-full glass-control">
                  <button
                    type="button"
                    onClick={() => setBottomTab("connections")}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      bottomTab === "connections" ? "bg-white/50 text-black" : "text-black/55 hover:text-black"
                    }`}
                  >
                    Connections
                  </button>
                  <button
                    type="button"
                    onClick={() => setBottomTab("graph")}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      bottomTab === "graph" ? "bg-white/50 text-black" : "text-black/55 hover:text-black"
                    }`}
                  >
                    Graph
                  </button>
                </div>
              </div>
            </div>

            {bottomTab === "connections" ? (
              <div className="space-y-3">
                {/* Project Root */}
                <div className="rounded-2xl border border-white/50 bg-white/30 backdrop-blur-md p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center">
                      <LayoutGrid className="w-4 h-4 text-blue-600" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold">Project Root</div>
                      <div className="text-[0.6875rem] text-black/50">{files.length} file{files.length !== 1 ? "s" : ""} total</div>
                    </div>
                  </div>
                  {files.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {files.map((f) => (
                        <div key={f.id} className="inline-flex items-center gap-1.5 rounded-lg bg-white/50 border border-white/60 px-2.5 py-1 text-[0.6875rem] text-black/70">
                          {f.kind === "image" ? <ImageIcon className="w-3 h-3 text-black/40" /> :
                           f.kind === "video" ? <Video className="w-3 h-3 text-black/40" /> :
                           f.kind === "audio" ? <Music className="w-3 h-3 text-black/40" /> :
                           f.kind === "pdf" ? <FileText className="w-3 h-3 text-black/40" /> :
                           f.kind === "doc" ? <StickyNote className="w-3 h-3 text-black/40" /> :
                           f.kind === "spreadsheet" ? <Table className="w-3 h-3 text-black/40" /> :
                           f.kind === "link" ? <Link2 className="w-3 h-3 text-black/40" /> :
                           <FileIcon className="w-3 h-3 text-black/40" />}
                          <span className="truncate max-w-[7.5rem]">{f.name}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[0.6875rem] text-black/40">No files yet.</p>
                  )}
                </div>

                {/* Boards */}
                {boards.length > 0 ? boards.map((board) => {
                  const boardFiles = files.filter((f) => f.folderId === board.folderId && board.folderId != null);
                  return (
                    <div key={board.id} className="rounded-2xl border border-white/50 bg-white/30 backdrop-blur-md p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center">
                          <BrickWall className="w-4 h-4 text-blue-500" />
                        </div>
                        <div>
                          <div className="text-sm font-semibold">{board.title}</div>
                          <div className="text-[0.6875rem] text-black/50">{boardFiles.length} file{boardFiles.length !== 1 ? "s" : ""}</div>
                        </div>
                      </div>
                      {boardFiles.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {boardFiles.map((f) => (
                            <div key={f.id} className="inline-flex items-center gap-1.5 rounded-lg bg-white/50 border border-white/60 px-2.5 py-1 text-[0.6875rem] text-black/70">
                              {f.kind === "image" ? <ImageIcon className="w-3 h-3 text-black/40" /> :
                               f.kind === "video" ? <Video className="w-3 h-3 text-black/40" /> :
                               f.kind === "audio" ? <Music className="w-3 h-3 text-black/40" /> :
                               f.kind === "pdf" ? <FileText className="w-3 h-3 text-black/40" /> :
                               f.kind === "doc" ? <StickyNote className="w-3 h-3 text-black/40" /> :
                               f.kind === "spreadsheet" ? <Table className="w-3 h-3 text-black/40" /> :
                               f.kind === "link" ? <Link2 className="w-3 h-3 text-black/40" /> :
                               <FileIcon className="w-3 h-3 text-black/40" />}
                              <span className="truncate max-w-[7.5rem]">{f.name}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[0.6875rem] text-black/40">No files in this board.</p>
                      )}
                    </div>
                  );
                }) : (
                  <div className="rounded-2xl border border-white/50 bg-white/30 backdrop-blur-md p-4 text-center">
                    <p className="text-[0.6875rem] text-black/40">No boards yet. Create one above.</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-5">
                {/* Stat cards row */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {[
                    { label: "Boards", value: boards.length, color: "#1d4ed8" },
                    { label: "Files", value: files.length, color: "#3b82f6" },
                    { label: "Chats", value: chatMessages.filter((m) => m.role === "user").length, color: "#60a5fa" },
                    { label: "Connections", value: 0, color: "#93c5fd" },
                  ].map((stat) => (
                    <div key={stat.label} className="rounded-xl border border-white/50 bg-white/40 backdrop-blur-md p-3 text-center">
                      <div className="text-xl font-bold" style={{ color: stat.color }}>{stat.value}</div>
                      <div className="text-[0.6875rem] text-black/50 mt-0.5">{stat.label}</div>
                    </div>
                  ))}
                </div>

                {/* Bar chart: content breakdown */}
                <div className="rounded-xl border border-white/50 bg-white/30 backdrop-blur-md p-4">
                  <div className="text-xs font-semibold mb-3">Content Breakdown</div>
                  <div className="space-y-2.5">
                    {[
                      { label: "Images", value: files.filter((f) => f.kind === "image").length, max: Math.max(files.length, 1), color: "#1d4ed8" },
                      { label: "Videos", value: files.filter((f) => f.kind === "video").length, max: Math.max(files.length, 1), color: "#2563eb" },
                      { label: "Documents", value: files.filter((f) => f.kind === "pdf" || f.kind === "doc" || f.kind === "spreadsheet").length, max: Math.max(files.length, 1), color: "#3b82f6" },
                      { label: "Audio", value: files.filter((f) => f.kind === "audio").length, max: Math.max(files.length, 1), color: "#60a5fa" },
                      { label: "Links", value: files.filter((f) => f.kind === "link").length, max: Math.max(files.length, 1), color: "#93c5fd" },
                      { label: "Other", value: files.filter((f) => f.kind === "file").length, max: Math.max(files.length, 1), color: "#bfdbfe" },
                    ].map((bar) => (
                      <div key={bar.label} className="flex items-center gap-2">
                        <span className="text-[0.6875rem] text-black/60 w-16 shrink-0">{bar.label}</span>
                        <div className="flex-1 h-4 rounded-full bg-black/5 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${Math.max((bar.value / bar.max) * 100, bar.value > 0 ? 8 : 0)}%`, backgroundColor: bar.color }}
                          />
                        </div>
                        <span className="text-[0.6875rem] font-medium w-5 text-right">{bar.value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Activity sparkline (filler) */}
                <div className="rounded-xl border border-white/50 bg-white/30 backdrop-blur-md p-4">
                  <div className="text-xs font-semibold mb-3">Weekly Activity</div>
                  <div className="flex items-end gap-1.5 h-20">
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => {
                      const heights = [35, 55, 42, 68, 80, 25, 48];
                      return (
                        <div key={day} className="flex-1 flex flex-col items-center gap-1">
                          <div
                            className="w-full rounded-md transition-all duration-500"
                            style={{
                              height: `${heights[i]}%`,
                              backgroundColor: i === new Date().getDay() - 1 ? "#3b82f6" : "rgba(0,0,0,0.08)",
                            }}
                          />
                          <span className="text-[9px] text-black/40">{day}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Collaboration & storage (filler) */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/50 bg-white/30 backdrop-blur-md p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs font-semibold">Team Space</div>
                      <span className="text-[0.625rem] font-medium text-blue-500/70 bg-blue-500/10 px-2 py-0.5 rounded-full">Coming soon</span>
                    </div>
                    <div className="flex -space-x-2">
                      {user?.user_metadata?.avatar_url ? (
                        <img
                          src={user.user_metadata.avatar_url}
                          alt={user.user_metadata?.full_name || "You"}
                          className="w-8 h-8 rounded-full border-2 border-white object-cover relative z-10"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full border-2 border-white bg-blue-500 flex items-center justify-center text-[0.6875rem] font-bold text-white relative z-10">
                          {(user?.email?.[0] || "?").toUpperCase()}
                        </div>
                      )}
                      <button
                        type="button"
                        disabled
                        className="w-8 h-8 rounded-full border-2 border-white bg-blue-500 flex items-center justify-center cursor-not-allowed opacity-70 relative z-0"
                        title="Add team members (coming soon)"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-white" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" />
                        </svg>
                      </button>
                    </div>
                    <div className="text-[0.6875rem] text-black/50 mt-2">
                      {user?.user_metadata?.full_name || user?.email || "1 member"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/50 bg-white/30 backdrop-blur-md p-4">
                    <div className="text-xs font-semibold mb-2">Storage Used</div>
                    {(() => {
                      const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
                      const maxBytes = 10 * 1024 * 1024 * 1024;
                      const pct = Math.min((totalBytes / maxBytes) * 100, 100);
                      const fmt = (bytes: number) => {
                        if (bytes < 1024) return `${bytes} B`;
                        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
                      };
                      return (
                        <>
                          <div className="relative h-2 rounded-full bg-black/5 overflow-hidden mt-3">
                            <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex items-center justify-between mt-2">
                            <span className="text-[0.6875rem] text-black/50">{fmt(totalBytes)}</span>
                            <span className="text-[0.6875rem] text-black/40">of 10 GB</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Right: AI Summary + AI Suggestions */}
        <div className="md:col-span-2 xl:col-span-1 grid grid-cols-1 md:grid-cols-3 xl:grid-cols-1 gap-3 xl:gap-5">
          <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-3 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">AI Summary</h2>
            </div>
            <p className="text-xs text-black/70 leading-relaxed">
              {projectSummary.summary}
            </p>
          </section>

          <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-3 sm:p-5">
            <div className="mb-3">
              <h2 className="text-sm font-semibold">AI Suggestions</h2>
            </div>
            <div className="space-y-2.5">
              {[
                ...(boards.length === 0
                  ? [{ text: "Create your first board to start organizing ideas", action: "create-board", icon: "plus" }]
                  : []),
                ...(files.length === 0
                  ? [{ text: "Drop files into the project to build your knowledge base", action: "add-files", icon: "file" }]
                  : []),
                ...(files.length > 0 && boards.length > 0
                  ? [{ text: "Connect your files to boards in the Connections view", action: "connect", icon: "link" }]
                  : []),
                ...(boards.length >= 2
                  ? [{ text: "Compare ideas across boards using the Graph view", action: "graph", icon: "graph" }]
                  : []),
                ...(chatMessages.filter((m) => m.role === "user").length === 0
                  ? [{ text: "Start a chat to brainstorm with AI about this project", action: "chat", icon: "chat" }]
                  : []),
                ...(files.filter((f) => f.kind === "image").length >= 3
                  ? [{ text: "You have several images — try creating a mood board", action: "mood", icon: "image" }]
                  : []),
                ...(boards.length > 5
                  ? [{ text: "Consider archiving inactive boards to stay focused", action: "archive", icon: "archive" }]
                  : []),
                { text: "Review your project health score for improvement tips", action: "health", icon: "heart" },
                { text: "Use quick notes to capture fleeting ideas instantly", action: "notes", icon: "note" },
              ]
                .slice(0, 5)
                .map((suggestion) => (
                  <button
                    key={suggestion.action}
                    type="button"
                    onClick={() => {
                      if (suggestion.action === "create-board") handleCreateBoard();
                      else if (suggestion.action === "chat") setShowChat(true);
                      else if (suggestion.action === "graph") setBottomTab("graph");
                      else if (suggestion.action === "notes") setShowQuickNote(true);
                    }}
                    className="w-full text-left rounded-xl border border-white/50 bg-white/40 hover:bg-white/60 backdrop-blur-md p-3 transition-all group"
                  >
                    <div className="text-xs text-black/80 leading-relaxed group-hover:text-black">
                      {suggestion.text}
                    </div>
                    <div className="text-[0.625rem] text-black/40 mt-1 group-hover:text-black/55">
                      Click to take action
                    </div>
                  </button>
                ))}
            </div>
          </section>

          {/* Project Health */}
          <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-3 sm:p-4">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="w-4 h-4 text-black/60" />
              <h2 className="text-sm font-semibold">Project Health</h2>
            </div>

            <div className="flex items-center gap-3 mb-3">
              <div
                className="relative w-12 h-12 rounded-full flex items-center justify-center"
                style={{
                  background: `conic-gradient(${projectHealth.color} ${projectHealth.score * 3.6}deg, rgba(0,0,0,0.06) 0deg)`,
                }}
              >
                <div className="w-9 h-9 rounded-full bg-[#e9e9ef] flex items-center justify-center text-xs font-bold">
                  {projectHealth.score}
                </div>
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: projectHealth.color }}>
                  {projectHealth.label}
                </div>
                <div className="text-[0.6875rem] text-black/50">Health score</div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-black/60">
                  <Eye className="w-3.5 h-3.5" />
                  Visits
                </span>
                <span className="font-medium">{projectHealth.visits}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-black/60">
                  <Clock className="w-3.5 h-3.5" />
                  Time spent
                </span>
                <span className="font-medium">{formatTimeSpent(projectHealth.totalSeconds)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-black/60">
                  <Activity className="w-3.5 h-3.5" />
                  Last active
                </span>
                <span className="font-medium">{formatLastVisit(projectHealth.lastVisit)}</span>
              </div>
            </div>
          </section>
        </div>
      </main>

      {isDragging && (
        <div className="fixed inset-0 z-[90] bg-black/30 backdrop-blur-sm flex items-center justify-center">
          <div className="rounded-2xl border border-white/60 bg-white/70 backdrop-blur-md px-6 py-4 text-sm text-black/70 shadow-xl">
            Drop files to add them to the current folder
          </div>
        </div>
      )}

      {selectedFile && (
        <div className="fixed inset-0 z-[95] bg-black/40 backdrop-blur-sm flex items-center justify-center">
          <div className="rounded-2xl border border-white/60 bg-white/80 backdrop-blur-md p-4 shadow-2xl w-[min(900px,94vw)]">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-black/70 truncate">{selectedFile.name}</div>
              <button
                type="button"
                onClick={() => setSelectedFile(null)}
                className="rounded-full px-3 py-1 text-xs glass-control hover:opacity-90"
              >
                Close
              </button>
            </div>
            {renderFilePreview(selectedFile)}
          </div>
        </div>
      )}

      <Dialog open={!!moveBoardId} onOpenChange={(open) => !open && setMoveBoardId(null)}>
        <DialogContent className="rounded-2xl border border-white/60 bg-[#f2f2f7]/85 backdrop-blur-lg text-black shadow-2xl">
          <DialogHeader>
            <DialogTitle>Move board</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {(allProjects as Array<{ id: string; name: string }>)
              .filter((p) => p.id !== projectId)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleMoveBoard(moveBoardId as string, p.id)}
                  className="w-full text-left text-sm px-3 py-2 rounded-xl bg-white/60 border border-white/60 backdrop-blur-md hover:opacity-90"
                >
                  {p.name}
                </button>
              ))}
            {(allProjects as Array<{ id: string; name: string }>).filter((p) => p.id !== projectId).length === 0 && (
              <div className="text-sm text-black/60">No other projects available.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {showChat && (
        <DraggableChat
          messages={chatMessages}
          input={chatInput}
          setInput={setChatInput}
          onSend={handleChatSend}
          isLoading={isChatLoading}
          onClose={() => setShowChat(false)}
          onNoteClick={() => {}}
        />
      )}

      {showQuickNote && (
        <DraggableQuickNote
          title={quickNoteTitle}
          content={quickNoteContent}
          setTitle={setQuickNoteTitle}
          setContent={setQuickNoteContent}
          isSaving={isQuickNoteSaving}
          onSave={handleSaveQuickNote}
          onClose={() => setShowQuickNote(false)}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Media Sidebar */}
      {showMemorySidebar && (
        <aside
          className="fixed top-14 right-0 z-[95] bottom-0 w-[23.75rem] max-w-[92vw] border-l border-black/10 dark:border-white/10 bg-[#f5f5f5] dark:bg-[#1a1a1a] shadow-[-4px_0_24px_rgba(0,0,0,0.08)]"
        >
          <div className="h-full flex flex-col">
            <div className="px-4 py-3 border-b border-black/8 dark:border-white/8 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-black/90 dark:text-white/90">Media</h2>
                <p className="text-xs text-black/50 dark:text-white/50">Your files and media</p>
              </div>
              <button
                type="button"
                onClick={() => setShowMemorySidebar(false)}
                className="h-8 w-8 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors flex items-center justify-center"
                title="Close media sidebar"
              >
                <PanelRightClose className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <iframe
                src="/memory?embedded=1"
                title="Media"
                className="w-full h-full border-0"
              />
            </div>
          </div>
        </aside>
      )}

      <button
        type="button"
        onClick={() => setShowQuickNote((v) => !v)}
        className="fixed bottom-6 right-6 w-12 h-12 rounded-full glass-control hover:opacity-90 shadow-lg hover:shadow-xl transition-all flex items-center justify-center z-[80]"
        title="Quick Notes"
      >
        <StickyNote className="w-5 h-5" />
      </button>
    </div>
  );
}
