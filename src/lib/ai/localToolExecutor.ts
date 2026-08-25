/**
 * Local Mode client executor.
 *
 * The server can't run file/terminal tools — it emits an `awaiting_client`
 * tool_call event instead. This runs the tool in the Electron main process,
 * handles the approval round-trip for risky actions, and posts the final
 * result back to the server so the streaming turn can resume.
 */

import { runLocalTool, subscribeLocalMode, type LocalToolResult } from "@/lib/localMode";
import { requestLocalApproval } from "@/lib/ai/localToolApproval";
import { supabase } from "@/lib/supabase";
import { uploadFileToStorage } from "@/lib/vault/uploadFileToStorage";
import { openStudioTab } from "@/lib/studioTabs";
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import { arrangeDesktop } from "@/components/macdesktop/desktopArrange";
import { STUDIO_SHOW_BROWSER_EVENT } from "@/lib/lyknChat/openInStudioBrowser";

/**
 * Read-class tools don't change anything on disk, but browsing someone's
 * files is still sensitive — so the FIRST read in an app session asks the
 * user for permission. Approving covers further reads until the app reloads
 * or Local Mode is switched off; writes/commands keep asking per action.
 */
const READ_TOOLS = new Set([
  "local_list_dir",
  "local_read_file",
  "local_search_files",
  "local_pull_file",
  "local_synced_folders",
  "local_running_apps",
  "local_read_app",
]);

// The grant lives on globalThis so dev-time HMR module swaps don't silently
// reset it mid-conversation (module-scoped state split-brains across copies).
const gExec = globalThis as typeof globalThis & { __lyknLocalReadGranted?: boolean };
const isReadGranted = () => gExec.__lyknLocalReadGranted === true;
const setReadGranted = (v: boolean) => {
  gExec.__lyknLocalReadGranted = v;
};
// Turning Local Mode off revokes the session grant — flipping it back on
// starts fresh with a new permission prompt.
subscribeLocalMode((enabled) => {
  if (!enabled) setReadGranted(false);
});

function readActionSummary(name: string, args: Record<string, unknown>): string {
  const p = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "your files";
  if (name === "local_list_dir") return `Look inside ${p}`;
  if (name === "local_read_file") return `Read ${p}`;
  if (name === "local_search_files") return `Search your files under ${p === "your files" ? "your home folder" : p}`;
  if (name === "local_pull_file") return `Pull ${p} into this chat`;
  if (name === "local_synced_folders") return "Check which folders are synced with LYKN";
  if (name === "local_running_apps") return "See which apps are open on your Mac";
  if (name === "local_read_app") {
    const app = typeof args.app === "string" && args.app.trim() ? args.app.trim() : "the app you're using";
    return `Read what's showing in ${app}`;
  }
  return `Access ${p}`;
}

export type AwaitingLocalToolCall = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  localStreamId?: string;
};

async function postResult(
  apiBase: string,
  streamId: string,
  toolCallId: string,
  result: LocalToolResult,
): Promise<void> {
  let token = "";
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token || "";
  } catch {
    /* no session — the POST will 401 and the server will time the call out */
  }
  try {
    await fetch(`${apiBase}/api/ai/local-tool-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ streamId, toolCallId, result }),
    });
  } catch {
    /* network blip — the server-side wait will time out and report an error */
  }
}

/**
 * local_pull_file returns raw bytes from Electron main. Upload them to the
 * user's chat file storage and hand the MODEL only a URL + metadata — the
 * base64 payload must never reach the model's context (a 5 MB photo would be
 * ~7 MB of tokens).
 */
async function uploadPulledFile(result: LocalToolResult): Promise<LocalToolResult> {
  const dataBase64 = typeof result.dataBase64 === "string" ? result.dataBase64 : "";
  if (!result.ok || !dataBase64) return result;
  try {
    const { data } = await supabase.auth.getUser();
    const userId = data.user?.id || "";
    if (!userId) return { ok: false, error: "Not signed in — can't attach the file to the chat." };

    const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
    const name = String(result.name || "file");
    const mime = String(result.mime || "application/octet-stream");
    const safeName = name.replace(/[^\w.\-]+/g, "-").slice(0, 120) || "file";
    const storagePath = `${userId}/local-pull/${Date.now()}-${safeName}`;

    const uploaded = await uploadFileToStorage({
      file: new Blob([bytes], { type: mime }),
      userId,
      storagePath,
      contentType: mime,
    });
    const url = uploaded.signedUrl || uploaded.publicUrl || "";
    if (!url) return { ok: false, error: "Upload succeeded but no URL could be created." };
    return {
      ok: true,
      name,
      mime,
      kind: result.kind,
      size: result.size,
      path: result.path,
      url,
      storagePath: uploaded.storagePath,
      storageBucket: uploaded.bucket,
      // The chat UI renders the pulled file as a card from this exact result
      // (see local_pull_file in chatArtifacts.ts). A hand-copied signed URL
      // loses characters in the token and 400s with InvalidJWT — the model
      // must never write it out.
      note:
        `${name} is already attached to your reply and visible to the user as a card in the chat. ` +
        "Do NOT paste, transcribe, or link its URL in your reply text — just refer to the file by name.",
    };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "Failed to upload the pulled file." };
  }
}

function openLocalPathResult(result: LocalToolResult): void {
  if (!result.ok || typeof result.path !== "string" || !result.path) return;
  const type = result.type === "dir" ? "dir" : "file";
  if (type === "file") {
    const name = result.path.split("/").filter(Boolean).pop();
    openLyknMediaPop({ type: "file", path: result.path, name });
    return;
  }
  const parent = result.path;
  const params = new URLSearchParams({ loc: parent });
  const target = `/vault?${params.toString()}`;
  if (!openStudioTab("vault", target) && typeof window !== "undefined") {
    window.location.assign(target);
  }
}

/**
 * The desktop lives in the renderer, so the main process settles only what was
 * asked for and the arranging happens here. Done before the result is posted
 * rather than after, so what goes back to the model is what actually happened.
 */
function organizeDesktopResult(result: LocalToolResult): LocalToolResult {
  if (!result.ok) return result;
  const by = typeof result.by === "string" ? result.by : null;
  const moved = arrangeDesktop({ by });
  if (!moved) {
    return {
      ok: false,
      error:
        "There is nothing on the user's LYKN Home desktop to arrange — it has no icons yet. " +
        "Files appear there once Settings → Display → Sync my Desktop is on.",
    };
  }
  return { ...result, icons: moved, note: `${result.note} ${moved} icons were lined up.` };
}

type AgentBridge = {
  agentCreate?: (payload: { goal?: string }) => Promise<{ ok?: boolean; agentId?: string } | null>;
  studioAgentSend?: (
    text: string,
    attachments: unknown[],
    agentId: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
};

/**
 * local_browser_agent — the model decided this turn's work belongs in the
 * browser. Create a browser agent (its own tab), start the task, and move the
 * user to the browser so they can watch. No classifier, no offer round-trip:
 * the model read the tool description and made the call.
 */
async function startBrowserAgentTask(args: Record<string, unknown>): Promise<LocalToolResult> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!task) return { ok: false, error: "No task was provided for the browser agent." };
  const api = (globalThis as { lykn?: AgentBridge }).lykn;
  if (!api || typeof api.studioAgentSend !== "function") {
    return { ok: false, error: "The browser agent is only available in the desktop app." };
  }
  const goal = url ? `${task}\n\nStart at: ${url}` : task;
  // Agents and tabs pair one-to-one, so give the task its own agent. An empty
  // id falls back to the active agent — a shared tab beats refusing the task.
  let agentId = "";
  if (typeof api.agentCreate === "function") {
    try {
      const created = await api.agentCreate({ goal });
      if (created?.ok && created.agentId) agentId = String(created.agentId);
    } catch {
      /* fall through to the active agent */
    }
  }
  try {
    // Resolves when the whole browser run finishes — must not be awaited, or
    // this chat turn would block for the length of the browser task.
    void api.studioAgentSend(goal, [], agentId, {}).catch(() => {});
  } catch {
    return { ok: false, error: "Couldn't start the browser agent." };
  }
  try {
    window.dispatchEvent(new CustomEvent(STUDIO_SHOW_BROWSER_EVENT));
  } catch {
    /* the agent still runs; only the automatic reveal is lost */
  }
  return {
    ok: true,
    note:
      "The browser agent is now running the task in its own tab, and the user has been " +
      "moved to the browser to watch. Tell them it's underway there and they can take over " +
      "the tab anytime. Do NOT describe steps as if you performed them yourself.",
  };
}

/**
 * Run one local tool call and report the result to the server. Safe to call
 * fire-and-forget; never throws.
 */
export async function executeAwaitingLocalTool(
  tc: AwaitingLocalToolCall,
  apiBase: string,
): Promise<void> {
  const streamId = tc.localStreamId || "";
  const name = tc.name;
  const args = (tc.args || {}) as Record<string, unknown>;
  if (!streamId) return;

  // The browser handoff never touches the filesystem — it runs entirely
  // through the agent bridge, so it skips the local read/write machinery.
  if (name === "local_browser_agent") {
    const result = await startBrowserAgentTask(args);
    await postResult(apiBase, streamId, tc.id, result);
    return;
  }

  // First file access of the session — ask before touching anything.
  if (READ_TOOLS.has(name) && !isReadGranted()) {
    const approved = await requestLocalApproval({
      tool: name,
      summary: `${readActionSummary(name, args)} — allow LYKN to browse files for this session?`,
      args,
    });
    if (!approved) {
      await postResult(apiBase, streamId, tc.id, {
        ok: false,
        error:
          "Local Mode IS enabled, but the user did not approve the file-access permission prompt " +
          "(it may have been declined or missed). Do NOT say local access is unavailable — tell the " +
          "user to try again and click Approve on the permission dialog when it appears.",
      });
      return;
    }
    setReadGranted(true);
  }

  let result: LocalToolResult = await runLocalTool(name, args);

  if (name === "local_pull_file") {
    result = await uploadPulledFile(result);
  }

  if (name === "local_organize_desktop") {
    result = organizeDesktopResult(result);
  }

  if (result?.needsApproval === true) {
    const approved = await requestLocalApproval({
      tool: name,
      summary: String(result.summary || "Run this local action?"),
      args,
    });
    if (approved) {
      result = await runLocalTool(name, args, { approved: true });
    } else {
      result = { ok: false, error: "You declined this action." };
    }
  }

  await postResult(apiBase, streamId, tc.id, result);
  if (name === "local_open_path") openLocalPathResult(result);
}
