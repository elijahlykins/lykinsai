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
  lykn_listProjects: "Looking through your projects…",
  lykn_findConnections: "Connecting the dots…",
  lykn_getProjectNeurons: "Pulling up the project…",
  lykn_getProjectState: "Checking where things stand…",
  lykn_loadNeuron: "Recalling the details…",
  lykn_loadNeurons: "Recalling the details…",
  lykn_searchVault: "Searching your vault…",
  lykn_getBeliefs: "Reviewing what matters to you…",
  lykn_getRules: "Checking your rules…",
  lykn_getFacts: "Remembering the details…",
  lykn_getNeuronLinks: "Tracing the connections…",
  lykn_getRecentActivity: "Catching up on what's new…",
  lykn_getUserPreferences: "Checking your settings…",

  // ── Synthesis / memory writes ──────────────────────────────────
  lykn_pushProjectState: "Updating the project…",
  lykn_addProjectNeurons: "Organizing your thinking…",
  lykn_removeProjectNeurons: "Tidying up the project…",
  lykn_setActiveProject: "Switching projects…",
  lykn_updateProject: "Updating the project…",
  lykn_deleteProject: "Removing the project…",
  lykn_proposeBelief: "Noting what matters to you…",
  lykn_proposeFact: "Remembering that…",
  lykn_createVaultNote: "Saving to your vault…",
  lykn_recordRuleApplication: "Logging that for you…",
  lykn_createNeuronLink: "Linking things together…",
  lykn_touchConcept: "Refreshing the idea…",
  lykn_updateUserPreference: "Updating your settings…",

  // ── Sub-agents ─────────────────────────────────────────────────
  lykn_delegate_to_sub_model: "Handing off to a specialist…",
  lykn_list_sub_model_tasks: "Checking on the sub-agents…",
  lykn_get_sub_model_task: "Checking the task status…",

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
  lykn_build_react_artifact: "Building…",
  lykn_render_video: "Rendering the video…",
  lykn_build_spreadsheet: "Building the spreadsheet…",
  lykn_manage_file: "Preparing the file…",
  lykn_parse_document: "Reading the document…",
  lykn_process_image: "Looking at the image…",
  lykn_transcribe_audio: "Transcribing the audio…",
  lykn_generate_speech: "Generating the audio…",
  lykn_translate: "Translating…",
  lykn_get_current_time: "Checking the time…",
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

/**
 * Status line for the chat "thinking" bubble while `name` is running.
 */
export function toolRunningStatus(name: string): string {
  return TOOL_RUNNING_STATUS[name] || humaniseToolName(name);
}
