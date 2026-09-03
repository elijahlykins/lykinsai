"use strict";

/**
 * connected_apps bot tool: instruction parsing, listing, calling through the
 * desktop MCP client, and the consequence-approval round trip.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createConnectedAppsTool,
  parseInstruction,
  matchConnection,
} = require("./runtime/connectedAppsTool.cjs");

function fakeMcpClient({ connections, details = {}, callResults = [] } = {}) {
  const calls = { callTool: [] };
  return {
    calls,
    async listConnections() {
      return connections;
    },
    async connectionDetail({ connectionId }) {
      return details[connectionId] || { tools: [] };
    },
    async callTool(opts) {
      calls.callTool.push(opts);
      return callResults.shift() || { ok: true, observation: { kind: "external_untrusted_observation" } };
    },
  };
}

const GMAIL = { id: "conn-gmail-1", name: "Gmail", status: "connected" };
const GMAIL_TOOLS = {
  tools: [
    { name: "GMAIL_FETCH_EMAILS", description: "Fetch emails", capabilities: ["communication.email.read"], consequence: "read" },
    { name: "GMAIL_SEND_EMAIL", description: "Send an email", capabilities: ["communication.email.send"], consequence: "consequential" },
  ],
};

test("instruction parsing: list vs JSON call", () => {
  assert.deepEqual(parseInstruction("list"), { mode: "list" });
  assert.deepEqual(parseInstruction(""), { mode: "list" });
  const call = parseInstruction('use gmail: {"app":"Gmail","tool":"GMAIL_FETCH_EMAILS","args":{"query":"from:dana"}}');
  assert.equal(call.mode, "call");
  assert.equal(call.app, "Gmail");
  assert.equal(call.tool, "GMAIL_FETCH_EMAILS");
  assert.deepEqual(call.args, { query: "from:dana" });
  assert.deepEqual(parseInstruction("{not json"), { mode: "list" });
});

test("matchConnection resolves by id, id prefix, and name", () => {
  const conns = [GMAIL, { id: "conn-slack-1", name: "Slack", status: "connected" }];
  assert.equal(matchConnection(conns, "conn-gmail-1").id, "conn-gmail-1");
  assert.equal(matchConnection(conns, "conn-slack").id, "conn-slack-1");
  assert.equal(matchConnection(conns, "gmail").id, "conn-gmail-1");
  assert.equal(matchConnection(conns, "unknown"), null);
});

test("list mode reports connected apps with tool consequences", async () => {
  const mcpClient = fakeMcpClient({ connections: [GMAIL], details: { "conn-gmail-1": GMAIL_TOOLS } });
  const tool = createConnectedAppsTool({ mcpClient, apiBase: "https://api", getAuthToken: async () => "t" });
  const result = await tool.execute({ instruction: "list" });
  assert.equal(result.ok, true);
  assert.match(result.output, /Gmail \[app id: conn-gmail-1\]/);
  assert.match(result.output, /GMAIL_SEND_EMAIL \(consequential\)/);
});

test("list mode with nothing connected points at Settings", async () => {
  const mcpClient = fakeMcpClient({ connections: [{ id: "x", name: "Broken", status: "authentication_required" }] });
  const tool = createConnectedAppsTool({ mcpClient, apiBase: "https://api", getAuthToken: async () => "t" });
  const result = await tool.execute({ instruction: "list" });
  assert.equal(result.ok, true);
  assert.match(result.output, /Settings → Connections/);
});

test("call mode sends the tool's capabilities in the task envelope", async () => {
  const mcpClient = fakeMcpClient({
    connections: [GMAIL],
    details: { "conn-gmail-1": GMAIL_TOOLS },
    callResults: [{ ok: true, observation: { kind: "external_untrusted_observation", content: [] } }],
  });
  const tool = createConnectedAppsTool({ mcpClient, apiBase: "https://api", getAuthToken: async () => "t" });
  const result = await tool.execute({
    instruction: '{"app":"gmail","tool":"GMAIL_FETCH_EMAILS","args":{"query":"is:unread"}}',
  });
  assert.equal(result.ok, true);
  const sent = mcpClient.calls.callTool[0];
  assert.equal(sent.connectionId, "conn-gmail-1");
  assert.equal(sent.toolName, "GMAIL_FETCH_EMAILS");
  assert.deepEqual(sent.args, { query: "is:unread" });
  assert.deepEqual(sent.task.capabilities, ["communication.email.read"]);
});

test("consequential call round-trips approval and retries with the token", async () => {
  const mcpClient = fakeMcpClient({
    connections: [GMAIL],
    details: { "conn-gmail-1": GMAIL_TOOLS },
    callResults: [
      { ok: false, status: "waiting_for_approval", approvalToken: "tok-1", request: { summary: "Send email to dana@example.com" } },
      { ok: true, observation: { kind: "external_untrusted_observation", content: [{ type: "text", text: "sent" }] } },
    ],
  });
  const tool = createConnectedAppsTool({ mcpClient, apiBase: "https://api", getAuthToken: async () => "t" });
  const questions = [];
  const result = await tool.execute({
    instruction: '{"app":"Gmail","tool":"GMAIL_SEND_EMAIL","args":{"to":"dana@example.com"}}',
    requestApproval: async ({ question }) => {
      questions.push(question);
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /dana@example\.com/);
  assert.equal(mcpClient.calls.callTool.length, 2);
  assert.equal(mcpClient.calls.callTool[1].approvalToken, "tok-1");
});

test("a declined approval is final and reported as such", async () => {
  const mcpClient = fakeMcpClient({
    connections: [GMAIL],
    details: { "conn-gmail-1": GMAIL_TOOLS },
    callResults: [{ ok: false, status: "waiting_for_approval", approvalToken: "tok-1", request: {} }],
  });
  const tool = createConnectedAppsTool({ mcpClient, apiBase: "https://api", getAuthToken: async () => "t" });
  const result = await tool.execute({
    instruction: '{"app":"Gmail","tool":"GMAIL_SEND_EMAIL","args":{}}',
    requestApproval: async () => false,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /declined/i);
  assert.equal(mcpClient.calls.callTool.length, 1);
});

test("headless runs stop at the approval gate without approving", async () => {
  const mcpClient = fakeMcpClient({
    connections: [GMAIL],
    details: { "conn-gmail-1": GMAIL_TOOLS },
    callResults: [{ ok: false, status: "waiting_for_approval", approvalToken: "tok-1", request: {} }],
  });
  const tool = createConnectedAppsTool({ mcpClient, apiBase: "https://api", getAuthToken: async () => "t" });
  const result = await tool.execute({ instruction: '{"app":"Gmail","tool":"GMAIL_SEND_EMAIL","args":{}}' });
  assert.equal(result.ok, false);
  assert.match(result.output, /needs the user's approval/);
  assert.equal(mcpClient.calls.callTool.length, 1);
});

test("unknown app or tool gets a corrective message, not a call", async () => {
  const mcpClient = fakeMcpClient({ connections: [GMAIL], details: { "conn-gmail-1": GMAIL_TOOLS } });
  const tool = createConnectedAppsTool({ mcpClient, apiBase: "https://api", getAuthToken: async () => "t" });
  const noApp = await tool.execute({ instruction: '{"app":"notion","tool":"X","args":{}}' });
  assert.equal(noApp.ok, false);
  assert.match(noApp.output, /No connected app matches/);
  const noTool = await tool.execute({ instruction: '{"app":"gmail","tool":"NOT_A_TOOL","args":{}}' });
  assert.equal(noTool.ok, false);
  assert.match(noTool.output, /no tool named NOT_A_TOOL/);
  assert.equal(mcpClient.calls.callTool.length, 0);
});
