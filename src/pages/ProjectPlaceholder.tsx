import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FolderPlus, Search as SearchIcon, MessageSquare, Folder, File } from "lucide-react";
import DraggableChat from "@/components/notes/DraggableChat";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery } from "@tanstack/react-query";
import { normalizeValueToV2, getBlockPlainText } from "@/components/notes/blockModel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMindmapStore } from "@/store/mindmapStore";

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

type FileEntry = {
  id: string;
  name: string;
  path: string;
  folderId: string | null;
  kind: "image" | "video" | "pdf" | "doc" | "link" | "file";
  url: string;
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
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [boards, setBoards] = useState<BoardEntry[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const [hoveredFolderId, setHoveredFolderId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [openBoardMenuId, setOpenBoardMenuId] = useState<string | null>(null);
  const boardMenuRef = useRef<HTMLDivElement | null>(null);
  const [moveBoardId, setMoveBoardId] = useState<string | null>(null);
  const [linkFromId, setLinkFromId] = useState<string | null>(null);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const mapRef = useRef<HTMLDivElement | null>(null);
  const lastPanRef = useRef<{ x: number; y: number } | null>(null);
  const dragMovedRef = useRef(false);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const mindmapNodes = useMindmapStore((s) => s.nodes);
  const mindmapId = useMindmapStore((s) => s.mindmapId);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const mindmapLoading = useMindmapStore((s) => s.isLoading);
  const mindmapSaving = useMindmapStore((s) => s.isSaving);
  const mindmapError = useMindmapStore((s) => s.lastError);
  const mindmapLinks = useMindmapStore((s) => s.links);
  const loadMindmapForProject = useMindmapStore((s) => s.loadMindmapForProject);
  const syncExternalNodes = useMindmapStore((s) => s.syncExternalNodes);
  const updateMindmapNode = useMindmapStore((s) => s.updateNode);
  const moveMindmapNode = useMindmapStore((s) => s.moveNode);
  const toggleMindmapLink = useMindmapStore((s) => s.toggleLink);
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
    const onClick = (event: MouseEvent) => {
      if (!boardMenuRef.current) return;
      if (boardMenuRef.current.contains(event.target as Node)) return;
      setOpenBoardMenuId(null);
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
    storeValue(`project:${projectId}`, { folders, files, activeFolderId });
  }, [activeFolderId, files, folders, projectId]);

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
        .order("created_at", { ascending: false });
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

  useEffect(() => {
    if (!projectId) return;
    loadMindmapForProject(projectId);
  }, [loadMindmapForProject, projectId]);

  useEffect(() => {
    if (!projectId || !mindmapId || !rootNodeId) return;
    const items = [
      ...files.map((file) => ({
        sourceType: "file" as const,
        sourceId: file.id,
        title: file.name,
      })),
      ...boards.map((board) => ({
        sourceType: "board" as const,
        sourceId: board.id,
        title: board.title,
      })),
    ];
    syncExternalNodes(items);
  }, [boards, files, mindmapId, projectId, rootNodeId, syncExternalNodes]);

  const { data: allNotes = [] } = useQuery({
    queryKey: ["notes", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      try {
        let { data, error } = await supabase
          .from("notes")
          .select("id, title, content, created_at, updated_at")
          .eq("user_id", user?.id || "")
          .order("created_at", { ascending: false });
        if (error && (error.code === "PGRST204" || error.message?.includes("Could not find"))) {
          ({ data, error } = await supabase
            .from("notes")
            .select("id, title, content")
            .eq("user_id", user?.id || "")
            .order("id", { ascending: false }));
        }
        if (error) return [];
        return data || [];
      } catch {
        return [];
      }
    },
    retry: 2,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
    cacheTime: 10 * 60 * 1000,
  });

  const { data: allProjects = [] } = useQuery({
    queryKey: ["projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("omnia_projects")
        .select("id, name")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      return data || [];
    },
    retry: 2,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
    cacheTime: 10 * 60 * 1000,
  });

  const filteredBoards = useMemo(() => {
    const base = activeFolderId ? boards.filter((b) => b.folderId === activeFolderId) : boards;
    if (!search.trim()) return base;
    return base.filter((b) => b.title.toLowerCase().includes(search.toLowerCase()));
  }, [activeFolderId, boards, search]);

  const folderFiles = useMemo(() => {
    return files.filter((f) => f.folderId === activeFolderId);
  }, [activeFolderId, files]);

  const connectionsNodes = useMemo(() => Object.values(mindmapNodes), [mindmapNodes]);

  const connectionsLinks = useMemo(() => Object.values(mindmapLinks), [mindmapLinks]);

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

  const handleCreateFolder = () => {
    const name = prompt("Folder name");
    if (!name) return;
    setFolders((prev) => [
      ...prev,
      { id: `folder-${Date.now()}`, name: name.trim(), parentId: activeFolderId },
    ]);
  };

  const handleRenameFolder = (folder: FolderEntry) => {
    const next = window.prompt("Rename folder", folder.name);
    if (!next || !next.trim()) return;
    const name = next.trim();
    setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, name } : f)));
  };

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
    if (!next || !next.trim()) return;
    const name = next.trim();
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

  const handleNodePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    nodeId: string
  ) => {
    event.stopPropagation();
    const node = mindmapNodes[nodeId];
    const pos = getPointerPercent(event);
    if (node && pos) {
      dragOffsetRef.current = {
        x: pos.x - node.positionX,
        y: pos.y - node.positionY,
      };
    }
    setDragNodeId(nodeId);
    dragMovedRef.current = false;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const handleNodePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragNodeId) return;
    event.stopPropagation();
    dragMovedRef.current = true;
    const pos = getPointerPercent(event);
    if (!pos) return;
    const offset = dragOffsetRef.current || { x: 0, y: 0 };
    updateMindmapNode(dragNodeId, {
      positionX: Math.max(2, Math.min(98, pos.x - offset.x)),
      positionY: Math.max(2, Math.min(98, pos.y - offset.y)),
    });
  };

  const handleNodePointerUp = (event: React.PointerEvent<HTMLButtonElement>, nodeId: string) => {
    event.stopPropagation();
    setDragNodeId(null);
    dragOffsetRef.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    if (nodeId === rootNodeId) {
      setLinkFromId(null);
      return;
    }
    if (!linkFromId) {
      setLinkFromId(nodeId);
      return;
    }
    if (linkFromId === nodeId) {
      setLinkFromId(null);
      return;
    }
    toggleMindmapLink(linkFromId, nodeId);
    setLinkFromId(null);
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
    setIsEditingTitle(false);
  };

  const handleDropFiles = (fileEntries: FileEntry[]) => {
    setFiles((prev) => [...fileEntries, ...prev]);
  };

  const classifyFile = (file: File) => {
    const name = file.name.toLowerCase();
    if (name.match(/\.(png|jpe?g|webp|gif)$/)) return "image";
    if (name.match(/\.(mp4|mov|webm|m4v)$/)) return "video";
    if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (
      name.endsWith(".doc") ||
      name.endsWith(".docx") ||
      name.endsWith(".ppt") ||
      name.endsWith(".pptx") ||
      name.endsWith(".xls") ||
      name.endsWith(".xlsx")
    ) {
      return "doc";
    }
    return "file";
  };

  const traverseEntry = (entry: any, currentPath: string, out: FileEntry[], targetFolderId: string | null) =>
    new Promise<void>((resolve) => {
      if (entry.isFile) {
        entry.file((file: File) => {
          const kind = classifyFile(file);
          const reader = new FileReader();
          reader.onload = () => {
            out.push({
              id: `file-${Date.now()}-${Math.random()}`,
              name: file.name,
              path: `${currentPath}${file.name}`,
              folderId: targetFolderId,
              kind,
              url: String(reader.result || ""),
            });
            resolve();
          };
          reader.onerror = () => {
            out.push({
              id: `file-${Date.now()}-${Math.random()}`,
              name: file.name,
              path: `${currentPath}${file.name}`,
              folderId: targetFolderId,
              kind,
              url: "",
            });
            resolve();
          };
          reader.readAsDataURL(file);
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        reader.readEntries(async (entries: any[]) => {
          for (const child of entries) {
            // eslint-disable-next-line no-await-in-loop
            await traverseEntry(child, `${currentPath}${entry.name}/`, out, targetFolderId);
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
    const tasks: Promise<void>[] = [];

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

    for (const item of items) {
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry) {
        tasks.push(traverseEntry(entry, "", fileEntries, targetFolderId));
      } else {
        const file = item.getAsFile?.();
        if (file) {
          const kind = classifyFile(file);
          fileEntries.push({
            id: `file-${Date.now()}-${Math.random()}`,
            name: file.name,
            path: file.name,
            folderId: targetFolderId,
            kind,
            url: URL.createObjectURL(file),
          });
        }
      }
    }
    await Promise.all(tasks);
    if (fileEntries.length) handleDropFiles(fileEntries);
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    await collectDropEntries(event, activeFolderId);
  };

  const handleFolderDrop = async (event: React.DragEvent, folderId: string | null) => {
    event.stopPropagation();
    if (draggedFileId) {
      setFiles((prev) => prev.map((f) => (f.id === draggedFileId ? { ...f, folderId } : f)));
      setDraggedFileId(null);
      return;
    }
    await collectDropEntries(event, folderId);
  };

  const renderFilePreview = (file: FileEntry) => {
    const lower = file.name.toLowerCase();
    const isImage = file.kind === "image" || /\.(png|jpe?g|webp|gif)$/i.test(lower);
    const isVideo = file.kind === "video" || /\.(mp4|mov|webm|m4v)$/i.test(lower);
    const isPdf = file.kind === "pdf" || /\.pdf$/i.test(lower);

    if (isImage) {
      return <img src={file.url} alt={file.name} className="max-h-[60vh] w-full object-contain rounded-lg" />;
    }
    if (isVideo) {
      return <video src={file.url} controls className="w-full max-h-[60vh] rounded-lg" />;
    }
    if (isPdf) {
      return (
        <iframe
          title={file.name}
          src={file.url}
          className="w-full h-[60vh] rounded-lg border border-white/40 bg-white/60"
        />
      );
    }
    if (file.kind === "link" && /youtube\.com|youtu\.be/i.test(file.url)) {
      const url = new URL(file.url);
      const videoId = url.searchParams.get("v") || url.pathname.split("/").pop();
      const embedUrl = videoId ? `https://www.youtube.com/embed/${videoId}` : file.url;
      return (
        <iframe
          title="YouTube"
          src={embedUrl}
          className="w-full h-[60vh] rounded-lg border border-white/40 bg-white/60"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      );
    }
    if (file.kind === "link") {
      return (
        <div className="text-sm text-black/70">
          <a href={file.url} target="_blank" rel="noreferrer" className="underline">
            Open link
          </a>
        </div>
      );
    }
    return (
      <div className="text-sm text-black/60">
        Preview not available. Download or open the file to view it.
      </div>
    );
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
        body: JSON.stringify({ model: selectedModel, prompt }),
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
      className="min-h-screen bg-[#f2f2f7]/80 text-black relative"
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
      <header className="fixed top-0 left-0 right-0 z-30 bg-[#f2f2f7]/80 backdrop-blur-md">
        <div className="mx-auto w-full max-w-6xl px-6 py-4">
          <div className="text-lg font-semibold">
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
                className="w-full max-w-[420px] bg-white/70 border border-white/60 rounded-lg px-3 py-1 text-lg font-semibold outline-none"
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
          <div className="mt-3 w-full flex items-center gap-2 rounded-xl border border-white/60 bg-white/70 backdrop-blur-md px-4 py-2 text-[12px] text-black/70">
            <SearchIcon className="w-4 h-4" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search boards"
              className="w-full bg-transparent outline-none placeholder:text-black/40"
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pt-28 pb-16 grid gap-6 lg:grid-cols-[240px_1fr]">
        <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Folders</h2>
            <button
              type="button"
              onClick={handleCreateFolder}
              className="rounded-full w-8 h-8 glass-control hover:opacity-90 flex items-center justify-center"
              title="Create folder"
            >
              <FolderPlus className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveFolderId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFolderDrop(e, null)}
              onDragEnter={() => setHoveredFolderId("root")}
              onDragLeave={() => setHoveredFolderId(null)}
              className={`w-full text-left px-3 py-2 rounded-xl ${
                activeFolderId === null ? "bg-white/40" : "hover:bg-white/30"
              } ${hoveredFolderId === "root" ? "ring-2 ring-white/60 bg-white/40" : ""}`}
            >
              All folders
            </button>
            {folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => setActiveFolderId(folder.id)}
                onDoubleClick={() => handleRenameFolder(folder)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleFolderDrop(e, folder.id)}
                onDragEnter={() => setHoveredFolderId(folder.id)}
                onDragLeave={() => setHoveredFolderId(null)}
                className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 ${
                  activeFolderId === folder.id ? "bg-white/40" : "hover:bg-white/30"
                } ${hoveredFolderId === folder.id ? "ring-2 ring-white/60 bg-white/40" : ""}`}
              >
                <Folder className="w-4 h-4 text-black/50" />
                {folder.name}
              </button>
            ))}
          </div>
          <div className="mt-4">
            <h3 className="text-xs font-semibold text-black/60 mb-2">Files in folder</h3>
            {folderFiles.length === 0 ? (
              <div className="text-xs text-black/50">Drop files here</div>
            ) : (
              <div className="space-y-1">
                {folderFiles.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => setSelectedFile(file)}
                    draggable
                    onDragStart={(e) => {
                      setDraggedFileId(file.id);
                      e.dataTransfer.setData("text/plain", file.id);
                    }}
                    onDragEnd={() => setDraggedFileId(null)}
                    className="w-full text-left text-xs text-black/70 flex items-center gap-2 hover:opacity-80"
                  >
                    <File className="w-3.5 h-3.5" />
                    <span className="truncate">{file.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Boards</h2>
              <p className="text-xs text-black/60">Create and organize boards inside this project.</p>
            </div>
            <button
              type="button"
              onClick={handleCreateBoard}
              className="rounded-full px-4 py-2 text-xs glass-control hover:opacity-90"
            >
              New board
            </button>
          </div>
          {filteredBoards.length === 0 ? (
            <div className="rounded-xl border border-white/50 bg-white/40 p-6 text-center text-sm text-black/60">
              No boards yet. Create one or drop files into a folder.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredBoards.map((board) => (
                <div
                  key={board.id}
                  className="group relative rounded-xl border border-white/60 bg-white/50 backdrop-blur-md p-4 shadow-lg text-left hover:opacity-90"
                >
                  <button
                    type="button"
                    onClick={() => {
                      localStorage.setItem("omnia_board_id", board.id);
                      nav(`/canvas/${board.id}`);
                    }}
                    className="absolute inset-0 z-10 rounded-xl"
                    aria-label={`Open ${board.title}`}
                  />
                  <div className="relative z-10">
                    <div className="text-sm font-semibold">{board.title}</div>
                    <div className="mt-2 text-xs text-black/50">Board</div>
                  </div>
                  <div className="absolute top-2 right-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="relative" ref={openBoardMenuId === board.id ? boardMenuRef : null}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenBoardMenuId((prev) => (prev === board.id ? null : board.id));
                        }}
                        className="w-7 h-7 rounded-full glass-control hover:opacity-90 flex items-center justify-center"
                        aria-label="Board actions"
                      >
                        <span className="text-lg leading-none">⋯</span>
                      </button>
                      {openBoardMenuId === board.id && (
                        <div className="absolute right-0 mt-2 w-48 rounded-xl border border-white/60 bg-white/80 backdrop-blur-md shadow-xl p-2">
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
                            Move board
                          </button>
                          <button
                            type="button"
                            className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5"
                          >
                            Share with team
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              handleDeleteBoard(board);
                              setOpenBoardMenuId(null);
                            }}
                            className="w-full text-left text-xs px-2 py-2 rounded-lg hover:bg-black/5 text-red-600"
                          >
                            Delete board
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="lg:col-span-2 rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Connections</h2>
              <p className="text-xs text-black/60">Drag nodes, click two to link, and pan the space.</p>
              {mindmapError && (
                <div className="mt-2 text-[11px] text-red-600/70">
                  Mindmap sync issue: {mindmapError}
                </div>
              )}
            </div>
            <div className="rounded-full border border-white/60 bg-white/60 px-3 py-1 text-[11px] text-black/60">
              {mindmapLoading ? "Loading..." : mindmapSaving ? "Saving..." : `${connectionsNodes.length} nodes`}
            </div>
          </div>
          <div
            ref={mapRef}
            className="relative overflow-hidden rounded-2xl border border-white/50 bg-[#f2f2f7]/70 backdrop-blur-md min-h-[320px]"
            onPointerDown={handleMapPointerDown}
            onPointerMove={handleMapPointerMove}
            onPointerUp={handleMapPointerUp}
            onPointerLeave={handleMapPointerUp}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/20 via-blue-500/10 to-fuchsia-500/15" />
            <div className="absolute -top-12 -right-10 h-36 w-36 rounded-full bg-sky-400/25 blur-2xl" />
            <div className="absolute -bottom-10 left-6 h-32 w-32 rounded-full bg-fuchsia-400/20 blur-2xl" />
            <div className="absolute inset-0 border border-white/40 pointer-events-none" />
            <div className="absolute inset-0 rounded-2xl ring-1 ring-white/40 pointer-events-none" />

            <div
              className="absolute inset-0"
              style={{
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) perspective(800px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
                transition: dragNodeId ? "none" : "transform 120ms ease-out",
              }}
            >
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                {connectionsLinks.map((link) => {
                  const from = connectionsNodes.find((n) => n.id === link.fromId);
                  const to = connectionsNodes.find((n) => n.id === link.toId);
                  if (!from || !to) return null;
                  return (
                    <line
                      key={link.id}
                      x1={`${from.positionX}%`}
                      y1={`${from.positionY}%`}
                      x2={`${to.positionX}%`}
                      y2={`${to.positionY}%`}
                      stroke="rgba(255,255,255,0.55)"
                      strokeWidth="2"
                    />
                  );
                })}
              </svg>

              {connectionsNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={(event) => handleNodePointerUp(event, node.id)}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 px-4 py-1 text-[11px] text-black/80 backdrop-blur-md shadow-lg ${
                    node.sourceType === "file" ? "bg-white/70" : "bg-[#f2f2f7]/80"
                  } ${linkFromId === node.id ? "ring-2 ring-white/80" : ""}`}
                  style={{ left: `${node.positionX}%`, top: `${node.positionY}%` }}
                >
                  {node.title}
                </button>
              ))}
            </div>

            <div className="absolute bottom-3 left-3 text-[11px] text-black/50">
              {linkFromId ? "Select another node to connect." : "Click a node to start linking."}
            </div>
          </div>
        </section>
      </main>

      <aside className="hidden xl:block fixed top-28 w-[280px] z-20 left-[calc(50%+36rem+1.5rem)]">
        <section className="rounded-2xl border border-white/60 bg-[#e9e9ef]/75 backdrop-blur-lg shadow-xl shadow-white/20 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">AI Summary</h2>
          </div>
          <p className="text-xs text-black/70 leading-relaxed">
            {projectSummary.summary}
          </p>
          <div className="mt-3">
            <div className="text-[10px] font-semibold text-black/60 mb-2">Suggestions</div>
            <ul className="space-y-1 text-[11px] text-black/70 list-disc pl-4">
              {projectSummary.suggestions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </section>
      </aside>

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

      <button
        type="button"
        onClick={() => setShowChat((v) => !v)}
        className="fixed bottom-6 right-6 w-12 h-12 rounded-full glass-control hover:opacity-90 shadow-lg hover:shadow-xl transition-all flex items-center justify-center z-[80]"
        title="Chat with AI"
      >
        <MessageSquare className="w-5 h-5" />
      </button>
    </div>
  );
}
