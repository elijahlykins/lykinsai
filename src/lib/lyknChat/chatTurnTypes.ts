// Shapes of a LyknChat conversation turn and its payloads: the PromptMessage
// row (user prompt + streamed AI response + bot/greeting metadata), attachments
// riding a turn (FocusedChatAttachment, BotSendAttachment), the orchestrator's
// action/result contracts, and the board->chat import payload with its
// localStorage key. Extracted verbatim from src/pages/LyknChat.tsx (LyknChat
// decomposition phase, see docs/REFACTOR_LOG.md).

/** Runtime-shaped attachment riding a Bot send (see botAttachments.js). */
export type BotSendAttachment = {
  kind: "image" | "text";
  name: string;
  dataUrl?: string;
  text?: string;
};

export type PromptMessage = {
  id: string;
  role: "user";
  content: string;
  aiResponse?: string;
  aiImageUrl?: string;
  aiYouTubeUrls?: { url: string; videoId: string }[];
  aiWebLinks?: string[];
  sources?: { title: string; url: string }[];
  kind?: "prompt" | "load-in-greeting";
  attachments?: FocusedChatAttachment[];
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
  aiResponseStats?: import("@/lib/synthesis/loadInUpdates").LoadInUpdatesStats;
};

export type CreateAction =
  | { type: "create_sheet"; content?: string; title?: string }
  | { type: "create_spreadsheet"; rows?: number; cols?: number; cells?: Record<string, string>; cells2d?: string[][] }
  | { type: "create_list"; listType?: "todo" | "bulleted" | "numbered"; items?: string[] }
  | { type: "create_design_board"; board?: any; title?: string; seedText?: string }
  | { type: "create_code_block"; language?: string; content?: string }
  | { type: "create_universal_block"; universalType?: string; name?: string; data?: Record<string, unknown> }
  | { type: "create_youtube_block"; url?: string; title?: string }
  | { type: "create_database_relation"; fromDatabaseName?: string; toDatabaseName?: string; relationType?: "one-to-one" | "one-to-many" | "many-to-many"; rollup?: { property?: string; aggregation?: "sum" | "count" | "average" } }
  | { type: "delete_block"; blockId?: string; blockIds?: string[] }
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
  canvasBlockId?: string;
  rawFile?: File;
};
