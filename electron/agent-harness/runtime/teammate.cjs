"use strict";

const ASK_TEAMMATE_RE = /\[\[\s*ask\s+([^:\]]{1,60}?)\s*:\s*([\s\S]{1,4000}?)\s*\]\]/i;

function parseAskTeammate(text) {
  const m = String(text || "").match(ASK_TEAMMATE_RE);
  if (!m) return null;
  const name = m[1].trim();
  const question = m[2].trim();
  return name && question ? { name, question } : null;
}

function looksLikeTeammateHandoff(text) {
  return parseAskTeammate(text) != null;
}

module.exports = { ASK_TEAMMATE_RE, parseAskTeammate, looksLikeTeammateHandoff };
