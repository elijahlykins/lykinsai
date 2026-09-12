// Status lines shown in the overlay thinking animation while Voice runs a tool.

const VOICE_TOOL_STATUS = {
  web_search: "Searching the web…",
  web_fetch: "Reading the page…",
  local_list_dir: "Looking through your files…",
  local_read_file: "Reading the file…",
  local_search_files: "Searching your files…",
  local_pull_file: "Pulling it in…",
  local_write_file: "Writing the file…",
  local_edit_file: "Editing the file…",
  local_run_command: "Running it on your Mac…",
  local_synced_folders: "Checking your synced folders…",
  local_running_apps: "Checking your open apps…",
  local_read_app: "Reading the app…",
  local_open_app: "Opening the app…",
  local_open_path: "Opening it…",
  local_organize_desktop: "Tidying your desktop…",
  open_app: "Opening it…",
  open_settings: "Opening your settings…",
  list_projects: "Looking through your projects…",
  get_project_state: "Checking the project…",
  list_events: "Checking your calendar…",
  list_reminders: "Checking your reminders…",
  list_todos: "Checking your to-dos…",
  generate_image: "Creating the image…",
  write_document: "Writing it out…",
  browser_agent: "Sending it to the browser…",
};

export function voiceToolStatus(name) {
  return VOICE_TOOL_STATUS[name] || "Working on it…";
}
