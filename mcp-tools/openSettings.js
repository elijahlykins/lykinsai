// ============================================================================
// mcp-tools/openSettings.js — let the chat put the user in front of a setting
// ============================================================================
// Most of what people mean by "change my settings" isn't something the chat can
// do for them: the wallpaper picker, the theme swatches, the billing plan, the
// connected apps. Rather than explain where to click, LYKN opens the right pane
// of Settings and lets them do it.
//
// Like updateAssistantInstructions, the EFFECT is client-side: Settings is a
// window in the desktop shell, so this server tool only settles which section
// was meant and echoes it back. The chat orchestrator sees the result and opens
// it (see chatSendOrchestrator.ts). Nothing here reads or writes user data.
//
// In-app ONLY: intentionally NOT in mcp-tools/index.js, because an external MCP
// client has no LYKN window to open.

import { jsonContent } from './content.js';

/** The panes of Settings, and what a user asking for each one sounds like.
 *  Ids match SETTINGS_VIEWS in src/pages/Studio.jsx — keep the two in step. */
const SECTIONS = [
  ['account', 'Account', 'their profile, name, email, avatar, password, or signing out'],
  ['workspace', 'Workspace', 'the Home desktop, widgets, synced Mac folders, and Local Mode file access'],
  ['models', 'Models', 'which AI model answers, routing, its name, voice, and custom instructions'],
  ['notifications', 'Notifications', 'alerts (coming soon)'],
  ['localVault', 'Local Vault', 'storing the vault on this device, and importing from the cloud'],
  ['installedApps', 'Apps', 'apps built in LYKN: their permissions, data, and uninstalling them'],
  ['privacy', 'Privacy', 'the privacy policy, terms, signed-in devices, and sessions'],
  ['appearance', 'Appearance', 'theme and dark mode, accent colour, wallpaper, fonts, and density'],
  ['integrations', 'Integrations', 'connecting outside apps like Google, Slack, or Notion'],
  ['billing', 'Billing', 'their plan, payment method, invoices, and cancelling'],
  ['keyboard', 'Keyboard', 'keyboard shortcuts'],
  ['advanced', 'Advanced', 'importing and exporting data, resetting to defaults, and support'],
];

const LABELS = Object.fromEntries(SECTIONS.map(([id, label]) => [id, label]));

/* Older ids that still appear in the product and in people's habits. Accepted
 * so a near-miss opens the right pane instead of dumping them on Account. */
const ALIASES = {
  display: 'appearance',
  theme: 'appearance',
  wallpaper: 'appearance',
  connections: 'integrations',
  payment: 'billing',
  subscription: 'billing',
  aiPersonalization: 'models',
  assistant: 'models',
  ai: 'models',
  import: 'advanced',
  help: 'advanced',
  profile: 'account',
  apps: 'installedApps',
};

/** The model occasionally reaches for a label ("Local Vault") or an older id
 *  rather than the enum. Meeting it halfway beats opening the wrong pane.
 *  Returns null for an empty ask (open Settings at the top) and for one that
 *  matches nothing, which the handler tells the model about. */
function resolveSection(raw) {
  if (!raw) return null;
  const key = ALIASES[raw] || raw;
  if (LABELS[key]) return key;
  const lower = raw.toLowerCase();
  const byLabel = SECTIONS.find(([, label]) => label.toLowerCase() === lower);
  return byLabel ? byLabel[0] : null;
}

export const openSettingsTool = {
  name: 'lykn_open_settings',
  title: 'Open the user\'s LYKN settings',
  scope: 'read',
  description: [
    'Open the user\'s LYKN Settings window, on the pane that matches what they',
    'asked about. Use this whenever they want to CHANGE something about LYKN',
    'that you cannot change for them — "open my settings", "change my',
    'wallpaper", "I want dark mode", "how do I cancel my plan", "connect my',
    'Google account", "change my password", "what are the keyboard shortcuts".',
    'It opens the pane so they can make the change themselves; it does not make',
    'the change. Say in one line what you opened and what to do there.',
    '',
    'Pick `section` from:',
    ...SECTIONS.map(([id, label, about]) => `  ${id} (${label}) — ${about}.`),
    '',
    'Omit `section` only when they just say "open settings" with no hint of',
    'what they want to change.',
    '',
    'Do NOT call this for how YOU behave — tone, personality, reply length,',
    'formatting ("be more concise", "stop using bullet points"). That is',
    'lykn_update_assistant_instructions, which actually makes the change and',
    'needs no window. Do NOT call it to answer a question ABOUT a setting that',
    'you can simply answer, and do not call it more than once in a turn.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: SECTIONS.map(([id]) => id),
        description: 'Which pane of Settings to open. Omit to open Settings at the top.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}) {
    const raw = String(args.section || '').trim();
    const section = resolveSection(raw);

    if (raw && !section) {
      return jsonContent({
        ok: false,
        error: 'unknown_section',
        sections: SECTIONS.map(([id]) => id),
        message: `LYKN has no "${raw}" settings pane. Pick one of the listed sections.`,
      });
    }

    return jsonContent({
      ok: true,
      section,
      label: section ? LABELS[section] : null,
      message: section
        ? `${LABELS[section]} settings are now open on the user's screen.`
        : "The user's settings are now open on their screen.",
    });
  },
};
