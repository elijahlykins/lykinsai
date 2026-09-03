/**
 * Browser side chat is ask-only. Agentic work belongs in Home LYKN Chat
 * or a custom agent. Disclosure and the stream prompt both use this.
 */

export const BROWSER_ASK_DENIED_FAMILIES = Object.freeze([
  "artifacts.build",
  "artifacts.edit",
  "documents.write",
  "coding.cursor",
  "local.files.read",
  "local.files.write",
  "local.apps",
  "local.shell",
  "local.desktop",
  "browser.agent",
  "bots.ask",
  "connections.external",
  "media.image",
  "media.video",
  "media.audio",
  "self.write",
  "projects.write",
  "projects.destroy",
  "vault.write",
  "prefs.write",
  "steward.write",
  "calendar.write",
  "reminders.write",
  "tasks.write",
]);

export const BROWSER_ASK_ONLY_PROMPT = `[BROWSER SIDE CHAT - ASK ONLY]
This turn is from the LYKN Browser side chat. Answer questions about the current page and talk. Do not do agentic work from here: no browsing or clicking for them, no bots, no custom agents, no files, apps, email, automations, or builds.

If they want you to act, tell them in one or two short sentences:
- Use LYKN Chat on the Home desktop for agentic work.
- Or build a custom agent in LYKN for work that should keep happening.

Do not claim you started that work. Do not call action tools.`;

export function isBrowserAskRequest(body) {
  return body?.browserAsk === true;
}

export function applyBrowserAskCapabilities(caps, extra) {
  if (!caps || typeof caps.delete !== "function") return extra;
  for (const family of BROWSER_ASK_DENIED_FAMILIES) caps.delete(family);
  if (extra && Array.isArray(extra.externalNeeds)) extra.externalNeeds = [];
  return extra;
}

export function stripBrowserAskToolNames(names, localToolNames = []) {
  const set = names instanceof Set ? names : new Set(Array.isArray(names) ? names : []);
  for (const name of localToolNames) set.delete(name);
  set.delete("local_ask_bot");
  set.delete("local_browser_agent");
  set.delete("lykn_open_app");
  set.delete("lykn_list_apps");
  set.delete("lykn_call_app");
  set.delete("lykn_create_routine");
  set.delete("lykn_search_connected_tools");
  set.delete("lykn_call_connected_tool");
  set.delete("lykn_delegate_to_sub_model");
  set.delete("lykn_list_sub_model_tasks");
  set.delete("lykn_get_sub_model_task");
  set.delete("lykn_communicate_with_model");
  return set;
}
