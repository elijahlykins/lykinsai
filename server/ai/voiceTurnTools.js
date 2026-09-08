/**
 * Per-utterance Voice tool disclosure.
 * Same FirstPartyCapabilityResolver Chat uses. Voice does not add a second
 * phrase list or capability allowlist. The model picks among disclosed tools.
 */

import {
  mcpContextFromConversation,
  turnNeedsConnectedAppResolve,
} from '../../lib/mcp/connectedStreamTurn.js';
import { resolveMcpToolsForTurn } from '../../lib/mcp/chatTurn.js';
import {
  resolveVoiceTurnDisclosure,
  serializeVoiceRealtimeTools,
} from '../../mcp-tools/voiceToolResolver.js';

export function utteranceWantsLiveScreen(text) {
  return /\b(?:screen|looking at|what(?:'s| is) (?:this|that|on)|see this|on my (?:screen|display|monitor)|this (?:page|window|tab))\b/i.test(
    String(text || ''),
  );
}

export function voiceUtteranceWantsToolInterrupt(disclosure, tools) {
  if (disclosure?.keepToolsOn) return true;
  if ((disclosure?.externalTools || []).length) return true;
  return Array.isArray(tools) && tools.length > 0;
}

export async function resolveVoiceToolsForUtterance({
  manager,
  userId,
  message,
  conversation,
  localMode,
  lyknBots,
} = {}) {
  const text = String(message || '').trim();
  const contextText = mcpContextFromConversation(conversation);
  let mcpTurn = { tools: [] };
  if (
    text &&
    userId &&
    manager &&
    turnNeedsConnectedAppResolve({ text, contextText })
  ) {
    try {
      mcpTurn = await resolveMcpToolsForTurn({
        manager,
        userId,
        text,
        contextText,
      });
    } catch {
      mcpTurn = { tools: [] };
    }
  }
  const disclosure = resolveVoiceTurnDisclosure({
    message: text,
    conversation,
    localMode: Boolean(localMode),
    lyknBots: Array.isArray(lyknBots) ? lyknBots : [],
    resolveExternal: () => mcpTurn.tools,
  });
  const tools = [
    ...serializeVoiceRealtimeTools(disclosure.firstPartyToolNames),
    ...(disclosure.externalTools || []).map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters:
        t.inputSchema && typeof t.inputSchema === 'object'
          ? t.inputSchema
          : { type: 'object', properties: {} },
    })),
  ];
  return {
    disclosure,
    mcpTurn,
    tools,
    interruptForTools: voiceUtteranceWantsToolInterrupt(disclosure, tools),
  };
}
