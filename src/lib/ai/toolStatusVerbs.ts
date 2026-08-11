/**
 * Friendly, present-tense status lines shown in the chat "thinking" bubble
 * while the in-app agent loop is running a tool. The point is to NARRATE
 * what the AI is doing in plain English — "Building the template…",
 * "Writing the document…", "Creating the image…" — instead of the raw
 * tool name ("Running build_template…") or a flat "Thinking…".
 *
 * Keep these abstract: they describe the ACTIVITY (building, writing,
 * drawing, searching) rather than exposing the underlying tool's plumbing.
 * When you add a tool to the chat whitelist, add a line here so the status
 * narrates it; anything unmapped falls back to a humanised tool name.
 */
const TOOL_RUNNING_STATUS: Record<string, string> = {
  // ── Synthesis / memory reads ───────────────────────────────────
  lykn_listProjects: "Connecting this to what you're on…",
  lykn_findConnections: "Connecting the dots…",
  lykn_getProjectNeurons: "Pulling up the project…",
  lykn_getProjectState: "Checking what you're on…",
  lykn_loadNeuron: "Recalling the details…",
  lykn_loadNeurons: "Recalling the details…",
  lykn_searchVault: "Checking what's in your stuff…",
  lykn_getBeliefs: "Remembering who you are…",
  lykn_getRules: "Checking how you work…",
  lykn_getFacts: "Recalling your preferences…",
  lykn_getNeuronLinks: "Tracing the connections…",
  lykn_getRecentActivity: "Catching up on what's new…",
  lykn_getUserPreferences: "Checking your preferences…",

  // ── Synthesis / memory writes ──────────────────────────────────
  lykn_pushProjectState: "Updating what you're on…",
  lykn_addProjectNeurons: "Organizing your thinking…",
  lykn_removeProjectNeurons: "Tidying up the project…",
  lykn_setActiveProject: "Switching what you're on…",
  lykn_updateProject: "Updating the project…",
  lykn_deleteProject: "Removing the project…",
  lykn_proposeBelief: "Updating who you are…",
  lykn_proposeFact: "Learning that about you…",
  lykn_createVaultNote: "Saving to your stuff…",
  lykn_recordRuleApplication: "Logging that for you…",
  lykn_createNeuronLink: "Linking things together…",
  lykn_touchConcept: "Refreshing the idea…",
  lykn_updateUserPreference: "Updating your settings…",

  // ── Exterior capabilities (the "building the thing out" cases) ──
  lykn_web_search: "Searching the web…",
  lykn_web_fetch: "Reading the page…",
  lykn_http_request: "Gathering resources…",
  lykn_calculate: "Crunching the numbers…",
  lykn_symbolic_math: "Working through the math…",
  lykn_run_python: "Running the analysis…",
  lykn_run_code: "Running the code…",
  lykn_generate_chart: "Building the chart…",
  lykn_generate_diagram: "Drawing the diagram…",
  lykn_generate_image: "Creating the image…",
  lykn_build_template: "Building the template…",
  lykn_build_react_artifact: "Building the app…",
  lykn_render_video: "Rendering the video…",
  lykn_build_spreadsheet: "Building the spreadsheet…",
  lykn_manage_file: "Preparing the file…",
  lykn_parse_document: "Reading the document…",
  lykn_process_image: "Looking at the image…",
  lykn_transcribe_audio: "Transcribing the audio…",
  lykn_generate_speech: "Generating the audio…",
  lykn_translate: "Translating…",
  lykn_get_current_time: "Checking the time…",

  // ── Local Mode (file + terminal access on the user's machine) ──
  local_list_dir: "Looking through your files…",
  local_read_file: "Reading the file…",
  local_search_files: "Searching your files…",
  local_pull_file: "Pulling it into the chat…",
  local_write_file: "Writing the file…",
  local_run_command: "Running it on your Mac…",
};

/**
 * Humanise an unmapped tool name into a readable activity line, e.g.
 * "lykn_build_widget" → "Working on build widget…". Best-effort fallback
 * so a freshly-added tool still narrates something sensible rather than
 * leaking its snake_case identifier.
 */
function humaniseToolName(name: string): string {
  const cleaned = name.replace(/^lykn_/, "").replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "Working on it…";
  return `Working on ${cleaned}…`;
}

function truncateForStatus(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Arg-aware detail line matching the deep-research narration style —
 * "Searching: lykn pricing…", "Reading nytimes.com…", "Building Landing
 * page…" — so every mode's status bubble shows WHAT the AI is working on,
 * not just the activity verb. Returns "" when the args carry nothing worth
 * surfacing (the generic verb map covers those).
 */
function toolDetailStatus(name: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  if (name === "lykn_web_search") {
    const q = typeof args.query === "string" ? args.query.trim() : "";
    return q ? `Searching: ${truncateForStatus(q, 48)}` : "";
  }
  if (name === "lykn_web_fetch" || name === "lykn_http_request") {
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) return "";
    try {
      return `Reading ${new URL(url).hostname.replace(/^www\./, "")}…`;
    } catch {
      return "";
    }
  }
  if (
    name === "lykn_build_react_artifact" ||
    name === "lykn_build_template" ||
    name === "lykn_build_spreadsheet"
  ) {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    return title ? `Building ${truncateForStatus(title, 40)}…` : "";
  }
  if (name === "lykn_render_video") {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    return title ? `Rendering ${truncateForStatus(title, 40)}…` : "";
  }
  if (name === "local_run_command") {
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    return cmd ? `Running: ${truncateForStatus(cmd, 48)}` : "";
  }
  if (
    name === "local_read_file" ||
    name === "local_write_file" ||
    name === "local_list_dir" ||
    name === "local_pull_file"
  ) {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path) return "";
    const leaf = path.split("/").filter(Boolean).pop() || path;
    if (name === "local_write_file") return `Writing ${truncateForStatus(leaf, 40)}…`;
    if (name === "local_read_file") return `Reading ${truncateForStatus(leaf, 40)}…`;
    if (name === "local_pull_file") return `Pulling in ${truncateForStatus(leaf, 40)}…`;
    return `Opening ${truncateForStatus(leaf, 40)}…`;
  }
  if (name === "local_search_files") {
    const q =
      typeof args.query === "string" && args.query.trim()
        ? args.query.trim()
        : typeof args.namePattern === "string"
          ? args.namePattern.trim()
          : "";
    return q ? `Searching your files: ${truncateForStatus(q, 40)}` : "";
  }
  return "";
}

/**
 * Status line for the chat "thinking" bubble while `name` is running.
 * Pass the tool call's args to get a detail-rich line (query / URL / title).
 */
export function toolRunningStatus(name: string, args?: Record<string, unknown>): string {
  return toolDetailStatus(name, args) || TOOL_RUNNING_STATUS[name] || humaniseToolName(name);
}
