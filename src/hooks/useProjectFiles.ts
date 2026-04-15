import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export interface ProjectFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ProjectFile {
  id: string;
  name: string;
  path: string;
  folderId: string | null;
  kind: string;
  url: string;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToFile(dataUrl: string, name: string, fallbackType = ""): File | null {
  try {
    const base64Match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (base64Match) {
      const mime = base64Match[1] || fallbackType || "application/octet-stream";
      const b64 = base64Match[2] || "";
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      return new File([blob], name, { type: mime });
    }
    const plainMatch = dataUrl.match(/^data:([^;]+)?,(.*)$/);
    if (plainMatch) {
      const mime = plainMatch[1] || fallbackType || "application/octet-stream";
      const text = decodeURIComponent(plainMatch[2] || "");
      const blob = new Blob([text], { type: mime });
      return new File([blob], name, { type: mime });
    }
    return null;
  } catch {
    return null;
  }
}

function classifyMime(mime: string, name: string): string {
  const ext = (name || "").split(".").pop()?.toLowerCase() || "";
  if (mime.startsWith("image/") || /^(png|jpe?g|webp|gif|svg|heic|heif|bmp)$/.test(ext)) return "image";
  if (mime.startsWith("video/") || /^(mp4|mov|webm|avi|mkv)$/.test(ext)) return "video";
  if (mime.startsWith("audio/") || /^(mp3|wav|ogg|flac|aac|m4a)$/.test(ext)) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  return "file";
}

export function useProjectFiles(
  boardId: string | null,
  userId: string | undefined,
) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);

  const persistProjectFileUrl = useCallback(
    (fileId: string, url: string) => {
      setProjectFiles((prev) => {
        const next = prev.map((f) => (f.id === fileId ? { ...f, url } : f));
        if (projectId) {
          try {
            const raw = localStorage.getItem(`project:${projectId}`);
            const parsed = raw ? JSON.parse(raw) : {};
            const folders = Array.isArray(parsed?.folders) ? parsed.folders : projectFolders;
            localStorage.setItem(
              `project:${projectId}`,
              JSON.stringify({ folders, files: next, activeFolderId: parsed?.activeFolderId ?? null }),
            );
          } catch { /* ignore */ }
        }
        return next;
      });
    },
    [projectId, projectFolders],
  );

  const resolveProjectFileToFile = useCallback(
    async (file: { id?: string; name: string; kind: string; url: string; path: string }): Promise<File | null> => {
      const fallbackType =
        file.kind === "image"
          ? "image/png"
          : file.kind === "video"
          ? "video/mp4"
          : file.kind === "pdf"
          ? "application/pdf"
          : "";
      if (file.url?.startsWith("data:")) {
        return dataUrlToFile(file.url, file.name, fallbackType);
      }
      const candidate = file.url || file.path || "";
      if (!candidate) return null;
      let blob: Blob | null = null;
      try {
        const res = await fetch(candidate);
        blob = await res.blob();
      } catch {
        return null;
      }
      try {
        const dataUrl = await blobToDataUrl(blob);
        if (dataUrl && file.id) persistProjectFileUrl(file.id, dataUrl);
      } catch { /* ignore */ }
      const type = blob.type || fallbackType;
      return new File([blob], file.name, { type });
    },
    [persistProjectFileUrl],
  );

  useEffect(() => {
    if (!boardId || !userId) return;
    let cancelled = false;
    const loadProjectForBoard = async () => {
      const { data } = await supabase
        .from("omnia_boards")
        .select("project_id")
        .eq("id", boardId)
        .eq("user_id", userId)
        .maybeSingle();
      if (cancelled) return;
      const pid = data?.project_id || null;
      setProjectId(pid);
      if (!pid) {
        setProjectName(null);
        setProjectFolders([]);
        setProjectFiles([]);
        return;
      }
      const { data: proj } = await supabase
        .from("omnia_projects")
        .select("name")
        .eq("id", pid)
        .maybeSingle();
      if (!cancelled) setProjectName(proj?.name || null);
      try {
        const raw = localStorage.getItem(`project:${pid}`);
        if (!raw) {
          setProjectFolders([]);
          setProjectFiles([]);
          return;
        }
        const parsed = JSON.parse(raw);
        setProjectFolders(Array.isArray(parsed?.folders) ? parsed.folders : []);
        setProjectFiles(Array.isArray(parsed?.files) ? parsed.files : []);
      } catch {
        setProjectFolders([]);
        setProjectFiles([]);
      }
    };
    loadProjectForBoard();
    return () => { cancelled = true; };
  }, [boardId, userId]);

  useEffect(() => {
    if (!userId) return;

    const onFileStored = (e: Event) => {
      const { fileName, fileUrl, storagePath, mimeType } =
        (e as CustomEvent).detail || {};
      if (!fileName || !fileUrl) return;
      const kind = classifyMime(mimeType || "", fileName);

      if (projectId) {
        setProjectFiles((prev) => {
          const isDupe = prev.some(
            (f) => f.name === fileName || (storagePath && f.path === storagePath),
          );
          if (isDupe) return prev;
          const entry: ProjectFile = {
            id: `file-${Date.now()}-${Math.random()}`,
            name: fileName,
            path: storagePath || fileName,
            folderId: null,
            kind,
            url: fileUrl,
          };
          const next = [entry, ...prev];
          try {
            const raw = localStorage.getItem(`project:${projectId}`);
            const parsed = raw ? JSON.parse(raw) : {};
            localStorage.setItem(
              `project:${projectId}`,
              JSON.stringify({
                folders: parsed?.folders || projectFolders,
                files: next,
                activeFolderId: parsed?.activeFolderId ?? null,
              }),
            );
          } catch { /* ignore */ }
          return next;
        });
      }
    };

    const onLinkStored = (e: Event) => {
      const { url } = (e as CustomEvent).detail || {};
      if (!url) return;

      if (projectId) {
        setProjectFiles((prev) => {
          const isDupe = prev.some((f) => f.url === url);
          if (isDupe) return prev;
          const entry: ProjectFile = {
            id: `file-${Date.now()}-${Math.random()}`,
            name: url,
            path: url,
            folderId: null,
            kind: "link",
            url,
          };
          const next = [entry, ...prev];
          try {
            const raw = localStorage.getItem(`project:${projectId}`);
            const parsed = raw ? JSON.parse(raw) : {};
            localStorage.setItem(
              `project:${projectId}`,
              JSON.stringify({
                folders: parsed?.folders || projectFolders,
                files: next,
                activeFolderId: parsed?.activeFolderId ?? null,
              }),
            );
          } catch { /* ignore */ }
          return next;
        });
      }
    };

    window.addEventListener("omnia_canvas_file_stored", onFileStored);
    window.addEventListener("omnia_canvas_link_stored", onLinkStored);
    return () => {
      window.removeEventListener("omnia_canvas_file_stored", onFileStored);
      window.removeEventListener("omnia_canvas_link_stored", onLinkStored);
    };
  }, [userId, projectId, projectName, projectFolders]);

  return {
    projectId,
    projectName,
    projectFolders,
    projectFiles,
    setProjectFiles,
    persistProjectFileUrl,
    resolveProjectFileToFile,
  };
}
