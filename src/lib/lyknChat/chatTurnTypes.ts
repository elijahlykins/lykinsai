// Canonical chat type authority for a LyknChat conversation turn and its
// payloads: the PromptMessage row (user prompt + streamed AI response + bot /
// greeting / tool-call / neuron metadata), attachments riding a turn
// (FocusedChatAttachment, BotSendAttachment), the orchestrator's action /
// result contracts, and the board->chat import payload with its localStorage
// key.
//
// This module is the ONE home for shared chat message/attachment types. The
// send pipeline (chatSendOrchestrator), the engine (useChatEngine), and the
// chat UI all import from here — the orchestrator re-exports these for
// legacy import paths but must not define its own copies (Wave 2 of the
// chat architecture refactor, see docs/REFACTOR_LOG.md).


/** Runtime-shaped attachment riding a Bot send (see botAttachments.js). */
export type BotSendAttachment = {
  kind: "image" | "text";
  name: string;
  dataUrl?: string;
  text?: string;
};

/**
 * One tool the AI invoked during this chat turn (the in-app agent loop in
 * server.js → chat-agent-loop.js). Lives on PromptMessage.toolCalls so the
 * chat surface can render an inline pill per call ("Listed 7 projects",
 * "Searched vault: 12 hits") below the assistant bubble.
 *
 * `status` transitions running → done | error as the server emits
 * `tool_call` SSE events. The orchestrator keeps the same `id` across
 * events so the UI updates the same pill in place.
 *
 * `result` is the JSON the tool handler returned (see runChatTool in
 * mcp-tools/chatTools.js). Shape varies by tool — readers should branch
 * on `name` before reading specific fields. Cap from the server is ~16KB,
 * so safe to keep in memory.
 */
export type ToolCallEvent = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * running → done | error for server-run tools. Local Mode tools add
   * `awaiting_client` (the desktop app must run the file/terminal tool) and
   * `awaiting_approval` (the client is showing the user an approval prompt).
   */
  status: "running" | "done" | "error" | "awaiting_client" | "awaiting_approval";
  result?: any;
  error?: string;
  latencyMs?: number;
  startedAt: number;
  finishedAt?: number;
};

/**
 * A neuron the AI has "brought into the chat" during this turn — currently
 * triggered when the in-app agent loop runs `lykn_loadNeuron` and the call
 * succeeds. The orchestrator extracts the rich payload from the tool result
 * and stashes it on the assistant message under `aiNeurons`; the chat
 * surface renders one ChatNeuronCard per entry under the assistant bubble.
 *
 * One entry per successful loadNeuron call. We dedupe on the `id` field
 * (the tool_call event id) so the same SSE event firing twice
 * (running → done) doesn't double-add the card.
 *
 * The shape is intentionally permissive (`payload: any`) — the rendering
 * component (ChatNeuronCard) is the authority on which kinds it supports
 * and how to lay each one out. The orchestrator just gates on `payload.ok
 * === true` and `payload.kind` being one of the recognised neuron kinds.
 */
export type ChatNeuronAttachment = {
  id: string;
  payload: any;
  addedAt: number;
  /**
   * True only for VAULT items the user explicitly asked to SEE in full this
   * turn ("pull that up", "bring it in", "show me the whole thing") or
   * affirmed an assistant offer to. The chat surface opens the full embedded
   * document reader (VaultDocumentViewer) on the card automatically when set.
   */
  autoOpen?: boolean;
};

export type PromptMessage = {
  id: string;
  role: "user";
  content: string;
  aiResponse?: string;
  aiImageUrl?: string;
  aiImageStoragePath?: string;
  /**
   * Imagine mode renders a batch of variations per prompt, so one turn can
   * carry several images where `aiImageUrl` carries one. The storage path is
   * the durable half — signed urls expire, and reSignChatAttachments mints a
   * fresh one from the path when the chat is loaded again.
   */
  aiImages?: { url: string; storagePath?: string }[];
  /**
   * What Imagine needs to rebuild its canvas from this turn: the ratio the
   * grid draws at, whether this was a fresh generation or an edit of an
   * earlier one, and the creative brief that edit rounds stay anchored to.
   */
  imagine?: {
    aspect: string;
    kind: "generate" | "refine" | "variations";
    concept?: string;
    batchId?: string;
    pending?: boolean;
  };
  aiYouTubeUrls?: { url: string; videoId: string }[];
  aiWebLinks?: string[];
  sources?: { title: string; url: string }[];
  /** "load-in-greeting" is the briefing the chat opens with rather than a
   *  turn the user typed. */
  kind?: "prompt" | "load-in-greeting";
  attachments?: FocusedChatAttachment[];
  /**
   * Tool calls fired by the in-app agent loop during this turn. Each entry
   * starts in `status: "running"` and transitions to `"done"` (or
   * `"error"`) once the server pushes the matching `tool_call` SSE event.
   * Render one pill per entry under the assistant bubble; see ToolCallPill.
   *
   * Order matches emission order from the server (hop 0 calls first, then
   * hop 1, …). Within a hop, OpenAI may emit parallel calls — those land
   * in whatever order they completed.
   */
  toolCalls?: ToolCallEvent[];
  /**
   * Vault items the AI brought into
   * the chat during this turn via lykn_loadNeuron. Each entry renders as
   * a rich ChatNeuronCard under the assistant bubble so the user can see
   * the actual saved item (image, link card, or note body)
   * directly in the conversation rather than relying on the model to
   * paraphrase it in text.
   *
   * Populated by the SSE `tool_call` handler when a `lykn_loadNeuron`
   * call lands with status `done` and `result.ok === true`. Deduped on
   * the tool_call id so repeated events for the same call don't double-
   * insert the card.
   */
  aiNeurons?: ChatNeuronAttachment[];
  /** ISO timestamp when the user sent this message. */
  createdAt?: string;
  /** Model id that produced aiResponse (for multi-model chat attribution). */
  aiModel?: string;
  /** ISO timestamp when the assistant reply finished streaming. */
  aiCompletedAt?: string;
  /** Set when this turn was addressed to a Bot instead of the chat model —
   *  the reply streams from its worker agent and the view shows its face. */
  bot?: { id: string; name: string; face: string; eyes: string; color: string };
  /** The Bot task carrying this turn — lets the row re-attach to the live
   *  stream after the user leaves the chat mid-task and comes back. */
  botTaskId?: string;
  /** True while the Bot's task is still running — the row shows an animated
   *  thinking indicator with `botStatus` (and the `botTrail` of recent
   *  statuses) under whatever has streamed so far. Cleared on the final
   *  update, and by the re-attach pass when a task settled off-screen. */
  botWorking?: boolean;
  botStatus?: string;
  botTrail?: string[];
  /** True when this turn was mirrored into the written chat by Voice Mode
   *  (spoken turn, assistant reply, or a voice-overlay paste/attach) rather
   *  than typed into the composer. Marker only — nothing branches on it
   *  today. See useChatVoiceMode. */
  viaVoice?: boolean;
  // Action buttons rendered below the assistant bubble. Populated only
  // by the load-in greeting today. Optional / ignored otherwise.
  aiResponseActions?: Array<{
    label: string;
    href: string;
    description?: string;
    tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
    /** Optional brand-mark URL for "Connect <Platform>" prompts. */
    iconUrl?: string;
  }>;
  // Structured sections for the load-in greeting: heading per topic,
  // each row carrying its own inline CTA button. When present the
  // renderer prefers this over the flat `aiResponseActions` strip.
  aiResponseSections?: Array<{
    id: string;
    heading: string;
    intro?: string;
    items: Array<{
      title: string;
      subtitle?: string;
      iconUrl?: string;
      action?: {
        label: string;
        href: string;
        description?: string;
        tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
        iconUrl?: string;
      };
    }>;
    summary?: string;
    groups?: Array<{
      id: string;
      label: string;
      iconUrl?: string;
      domain?: string;
      count: number;
      latestTitle?: string;
      latestRelative?: string;
      items: Array<{
        id: string;
        title: string;
        subtitle?: string;
        href?: string;
        /**
         * Optional "grounded in" chips rendered under the title. Used
         * for source-backed activity rows so the user can see and
         * click into the originating notes or events.
         * Absent on older cached briefings; renderer must
         * handle the array being missing without breaking.
         */
        provenance?: Array<{
          id: string;
          label: string;
          href?: string;
          connectorId?: string;
        }>;
      }>;
    }>;
    chips?: Array<{
      id: string;
      label: string;
      iconUrl: string;
      href: string;
      tone?: "primary" | "neutral" | "amber" | "emerald" | "fuchsia";
    }>;
    /**
     * When present, identifies this section as user-authored (a row in
     * `lykn_load_in_user_sections`). The chat renderer attaches inline
     * edit / delete affordances to sections that carry this id.
     */
    userSectionId?: string;
  }>;
  /**
   * Roll-up counts + 7-day activity series for the at-a-glance
   * dashboard panel rendered next to the load-in greeting. Pulled
   * verbatim from `LoadInUpdatesPayload.stats`. Optional so the
   * field is harmless for non-greeting turns.
   */
};

export type FocusedChatAttachment = {
  id: string;
  type: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  videoId?: string;
  vaultTitle?: string;
  vaultContent?: string;
  transcript?: string;
  pdfText?: string;
  extractedText?: string;
  /** Client-side OCR text recovered from an image attachment (fallback so
   *  dense/small text survives even on a weak-vision model). */
  ocrText?: string;
  /** AI vision description of an image (2-3 sentences: subject, colors, style,
   *  any text/logos). Lets the TEXT-ONLY voice LLM "see" a pasted image — it
   *  can't fetch the url, so without this a photo with no OCR text is invisible
   *  to it. Populated from /api/ai/describe-image. */
  aiDescription?: string;
  canvasBlockId?: string;
  rawFile?: File;
  /** Durable Supabase Storage location for binary attachments (image / pdf /
   *  file / video / audio). When set, the inline `url` (a data URL or a
   *  short-lived signed URL) is stripped on persist and re-minted from this
   *  path on reload by `reSignChatAttachments`, so the attachment survives
   *  leaving and returning to the chat. Without it, a stripped url can never
   *  be recovered and the image renders as "couldn't load image". */
  storagePath?: string;
  storageBucket?: string;
  /** Open Graph metadata for `link`/`bookmark` attachments, populated by
   *  the /api/unfurl endpoint so the chat renders the same rich
   *  LinkPreview card the Vault shows (hero image, site name, title,
   *  description) instead of a bare file chip. */
  linkTitle?: string;
  linkDescription?: string;
  linkImage?: string;
  linkSiteName?: string;
  linkFavicon?: string;
  oembedType?: string;
  authorName?: string;
  authorHandle?: string;
};

export type CreateAction =
  | { type: "create_sheet"; content?: string; title?: string }
  | { type: "create_spreadsheet"; rows?: number; cols?: number; cells?: Record<string, string>; cells2d?: string[][] }
  | { type: "create_table"; headers?: string[]; rows?: string[][]; cols?: number }
  | { type: "create_list"; listType?: "todo" | "bulleted" | "numbered"; items?: string[] }
  | { type: "create_design_board"; board?: any; title?: string; seedText?: string }
  | { type: "create_code_block"; language?: string; content?: string }
  | { type: "create_universal_block"; universalType?: string; name?: string; data?: Record<string, unknown> }
  | { type: "create_youtube_block"; url?: string; title?: string }
  | { type: "create_heading"; level?: 1 | 2 | 3; content?: string }
  | { type: "create_h1"; content?: string }
  | { type: "create_h2"; content?: string }
  | { type: "create_h3"; content?: string }
  | { type: "create_quote"; content?: string }
  | { type: "create_callout"; content?: string }
  | { type: "create_text"; content?: string; format?: string }
  | { type: "create_brick"; content?: string; format?: string }
  | { type: "create_text_block"; content?: string; format?: string }
  | { type: "create_card"; content?: string }
  | { type: "create_toggle"; content?: string }
  | { type: "create_task_board"; title?: string; columns?: Array<{ title: string; tasks?: string[] }> }
  | { type: "create_kanban"; title?: string; columns?: Array<{ title: string; tasks?: string[] }> }
  | { type: "create_media"; url?: string; mode?: string; name?: string }
  | { type: "create_embed"; url?: string; name?: string }
  | { type: "create_image_block"; url?: string; src?: string }
  | { type: "create_video_block"; url?: string }
  | { type: "organize_grid"; strategy?: "grid" | "column" | "vertical"; columns?: number }
  | { type: "auto_organize"; strategy?: string }
  | { type: "move_block"; blockId: string; x?: number; y?: number; dx?: number; dy?: number }
  | { type: "move_blocks"; moves: Array<{ blockId: string; x?: number; y?: number; dx?: number; dy?: number }> }
  | { type: "resize_block"; blockId: string; width?: number; height?: number }
  | { type: "update_text_block"; blockId: string; content?: string; append?: string; data?: Record<string, any> }
  | { type: "update_block"; blockId: string; content?: string; append?: string; data?: Record<string, any> }
  | { type: "edit_block"; blockId: string; content?: string; append?: string; data?: Record<string, any> }
  | { type: "update_list"; blockId: string; items?: string[]; append?: string[]; listType?: string }
  | { type: "update_spreadsheet"; blockId: string; cells?: Record<string, string>; cells2d?: string[][]; startRow?: number; startCol?: number }
  | { type: "update_code_block"; blockId: string; content?: string; append?: string; language?: string }
  | { type: "create_database_relation"; fromDatabaseName?: string; toDatabaseName?: string; relationType?: "one-to-one" | "one-to-many" | "many-to-many"; rollup?: { property?: string; aggregation?: "sum" | "count" | "average" } }
  | { type: "delete_block"; blockId?: string; blockIds?: string[] }
  | { type: "color_block"; blockId?: string; blockIds?: string[]; brickColor?: string; textColor?: string }
  | { type: "connect_blocks"; fromId: string; toId: string; fromSide?: string; toSide?: string }
  | { type: "add_wire"; fromId: string; toId: string; fromSide?: string; toSide?: string }
  | { type: "remove_connection"; fromId?: string; toId?: string; wireId?: string }
  | { type: "disconnect_blocks"; fromId?: string; toId?: string }
  | { type: "update_notes"; content: string | object }
  | { type: "append_notes"; content: string | object }
  | { type: string; [key: string]: any };

export type OrchestratorResult = {
  response: string;
  followUpQuestions: string[];
  actions: CreateAction[];
  requiresClarification: boolean;
  groundingSummary?: string;
};

export const CHAT_TO_BOARD_IMPORT_KEY = "lyknchat_chat_import_v1";

export type ImportedChatPrompt = {
  id?: string;
  role?: "user";
  content?: string;
  aiResponse?: string;
  kind?: "prompt";
};

export type ImportedTodoList = {
  id?: string;
  title?: string;
  items?: Array<{ text?: string; checked?: boolean }>;
};

export type ImportedChatAttachment = {
  id?: string;
  type?: string;
  url?: string;
  name?: string;
  videoId?: string;
  vaultTitle?: string;
  vaultContent?: string;
  transcript?: string;
  pdfText?: string;
  extractedText?: string;
  mime?: string;
};

export type ImportedChatBoardPayload = {
  version?: number;
  createdAt?: number;
  chatId?: string;
  source?: string;
  prompts?: ImportedChatPrompt[];
  todoLists?: ImportedTodoList[];
  attachments?: ImportedChatAttachment[];
};
