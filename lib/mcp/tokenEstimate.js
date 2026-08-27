/**
 * Token characterization for progressive disclosure.
 * Rough: 1 token ≈ 4 UTF-8 bytes of JSON schema.
 */

import { estimateSchemaTokens } from './chatBridge.js';

export { estimateSchemaTokens };

export function characterizeToolExposure({ firstPartyTools, mcpTools, label }) {
  return {
    label,
    firstPartyCount: firstPartyTools?.length || 0,
    mcpCount: mcpTools?.length || 0,
    totalCount: (firstPartyTools?.length || 0) + (mcpTools?.length || 0),
    firstPartyTokens: estimateSchemaTokens(firstPartyTools),
    mcpTokens: estimateSchemaTokens(mcpTools),
    totalTokens: estimateSchemaTokens([...(firstPartyTools || []), ...(mcpTools || [])]),
  };
}
