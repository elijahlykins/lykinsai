/**
 * Local Mode client executor.
 *
 * The server can't run file/terminal tools — it emits an `awaiting_client`
 * tool_call event instead. This runs the tool in the Electron main process,
 * handles the approval round-trip for risky actions, and posts the final
 * result back to the server so the streaming turn can resume.
 */

import { runLocalTool, type LocalToolResult } from "@/lib/localMode";
import { requestLocalApproval, type McpApprovalDetail } from "@/lib/ai/localToolApproval";
import { supabase } from "@/lib/supabase";
import { uploadFileToStorage } from "@/lib/vault/uploadFileToStorage";
import { openStudioTab } from "@/lib/studioTabs";
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import { arrangeDesktop } from "@/components/macdesktop/desktopArrange";
import { askBot } from "@/lib/bots/askBot";
import {
  startBrowserAgentTask,
  type LocalToolHostContext,
} from "@/lib/ai/browserAgentLaunch";

export { startBrowserAgentTask, type LocalToolHostContext };


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

/**
 * Run one Local Mode tool in the desktop renderer. Voice calls this directly
 * (no chat stream id). Chat posts the same result back to the server.
 */
export async function runLocalToolNow(
  name: string,
  args: Record<string, unknown>,
  host?: LocalToolHostContext,
): Promise<LocalToolResult> {
  if (name === "local_browser_agent") return startBrowserAgentTask(args, host);
  if (name === "local_ask_bot") return askBot(args);

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
      const approvalToken = typeof result.approvalToken === "string" ? result.approvalToken : "";
      result = await runLocalTool(name, args, { approvalToken });
    } else {
      result = { ok: false, error: "You declined this action." };
    }
  }

  if (name === "local_open_path") openLocalPathResult(result);
  return result;
}

/**
 * Run one local tool call and report the result to the server. Safe to call
 * fire-and-forget; never throws.
 */
export async function executeAwaitingLocalTool(
  tc: AwaitingLocalToolCall,
  apiBase: string,
  host?: LocalToolHostContext,
): Promise<void> {
  const streamId = tc.localStreamId || "";
  if (!streamId) return;
  const result = await runLocalToolNow(tc.name, (tc.args || {}) as Record<string, unknown>, host);
  await postResult(apiBase, streamId, tc.id, result);
}

/**
 * A consequential connected-app action (send email, delete, share) paused
 * server-side for live approval. Show the approval card — with the outgoing
 * content written out — and post the verdict back so the turn can resume.
 */
export async function respondToMcpApproval(
  tc: AwaitingLocalToolCall & { approval?: McpApprovalDetail },
  apiBase: string,
): Promise<void> {
  const streamId = tc.localStreamId || "";
  if (!streamId) return;
  const request = tc.approval || {};
  const account = request.accountIdentity ? ` (${request.accountIdentity})` : "";
  const summary =
    String(request.title || "").trim() ||
    `Allow this action in ${request.connectionName || "your connected app"}${account}?`;
  const approved = await requestLocalApproval({
    tool: "mcp_approval",
    summary,
    args: (request.arguments as Record<string, unknown>) || {},
    detail: request,
  });
  await postResult(apiBase, streamId, tc.id, { ok: true, approved });
}
