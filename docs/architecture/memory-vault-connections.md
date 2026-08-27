# Memory, Vault, and Connections

These three stores have different jobs. Do not blur them.

## MEMORY

Durable facts LYKN knows about the user.

Memory is written through first-party memory tools and policy.
It is not a mirror of Gmail, Drive, Notion, or Slack.

## VAULT

Content the user explicitly chooses to save or import into LYKN.

Vault is not a replica of an external application.
Reading an external resource for the current Task does not write Vault.

If the user says "save this into my Vault", that is a separate explicit Vault action.

## CONNECTIONS

Live authorized access to external authoritative applications.

The source application remains authoritative:

- Gmail stays in Gmail.
- Drive stays in Drive.
- Notion stays in Notion.
- Slack stays in Slack.
- GitHub stays in GitHub.

LYKN queries those systems live when a Task needs them.

MCP is the universal live-access lane.

## Policy

External authoritative data stays in its source app.
MCP provides live access.
Vault receives external data only when the user explicitly saves or imports it.

## Legacy Vault-sync connectors

`connectors/**` and `social_connections` are **LEGACY — pending MCP parity and demolition**.

They still sync provider content into Vault.
Do not add new work to that architecture unless a critical regression requires it.
Do not delete them until universal MCP live access is proven.

Replacement mapping (future, not this phase):

| Legacy Vault sync | Future live access |
|---|---|
| `connectors/google/gmail.js` | Gmail MCP |
| `connectors/google/drive.js` | Drive MCP |
| `connectors/google/calendar.js` | Calendar MCP |
| `connectors/notion.js` | Notion MCP |
| `connectors/slack.js` | Slack MCP |
| `connectors/github.js` | GitHub MCP |
| `connectors/linear.js` | Linear MCP |
| remaining vault-pull adapters | matching MCP servers where they exist |

`lykn_list_apps` / `lykn_call_app` / `customConnections` are isolated legacy REST dispatch.
They are not the future universal action layer.
