import { MCP_TRUST_LEVELS } from './protocol.js';

export const MCP_TRUST_LABELS = Object.freeze({
  [MCP_TRUST_LEVELS.OFFICIAL]: { label: 'Official', verified: true, warning: null },
  [MCP_TRUST_LEVELS.VERIFIED]: { label: 'Verified', verified: true, warning: null },
  [MCP_TRUST_LEVELS.ENTERPRISE]: { label: 'Enterprise', verified: true, warning: null },
  [MCP_TRUST_LEVELS.COMMUNITY]: {
    label: 'Community',
    verified: false,
    warning: 'LYKN has not audited this community server.',
  },
  [MCP_TRUST_LEVELS.CUSTOM]: {
    label: 'Custom MCP',
    verified: false,
    warning: 'You added this URL. TLS does not make it Official.',
  },
  [MCP_TRUST_LEVELS.REMOTE]: {
    label: 'Custom MCP',
    verified: false,
    warning: 'You added this URL. TLS does not make it Official.',
  },
  [MCP_TRUST_LEVELS.LOCAL_TRUSTED]: {
    label: 'Local MCP',
    verified: false,
    warning: 'This runs a program on this computer.',
  },
});

export function trustPresentation(trustLevel) {
  return MCP_TRUST_LABELS[trustLevel] || MCP_TRUST_LABELS[MCP_TRUST_LEVELS.CUSTOM];
}
