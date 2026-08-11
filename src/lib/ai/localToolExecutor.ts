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
      note:
        result.kind === "image"
          ? `Show it inline with: ![${name}](${url})`
          : `Link it with: [${name}](${url})`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "Failed to upload the pulled file." };
  }
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
}
