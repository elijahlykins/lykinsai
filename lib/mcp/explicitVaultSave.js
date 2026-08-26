/**
 * Product contract: live MCP reads never write Vault.
 *
 * External apps stay authoritative. LYKN retrieves live data through MCP.
 * The only intended external-data-to-Vault path is an explicit user request
 * handled by existing first-party Vault primitives.
 *
 * Do not add connector-specific ingestion here.
 */

export const MCP_READ_PERSISTS_TO_VAULT = false;

export const EXPLICIT_VAULT_SAVE_TOOLS = Object.freeze([
  'lykn_createVaultNote',
  'lykn_saveFileToVault',
  'lykn_saveLinkToVault',
]);

export const EXPLICIT_VAULT_SAVE_PRIMITIVE = {
  textOrEmailBody: 'lykn_createVaultNote',
  generatedFileOrArtifact: 'lykn_saveFileToVault',
  url: 'lykn_saveLinkToVault',
};

export function vaultSaveRequested(text) {
  const blob = String(text || '');
  return /\bsave\b.{0,80}\bvault\b|\bkeep\b.{0,80}\bvault\b|\bimport\b.{0,80}\bvault\b/i.test(blob);
}

export function planExplicitVaultSave(userText, { kind = 'text' } = {}) {
  if (!vaultSaveRequested(userText)) {
    return { persist: false, tool: null, reason: 'no_explicit_save_request' };
  }
  if (kind === 'file') {
    return { persist: true, tool: EXPLICIT_VAULT_SAVE_PRIMITIVE.generatedFileOrArtifact };
  }
  if (kind === 'url') {
    return { persist: true, tool: EXPLICIT_VAULT_SAVE_PRIMITIVE.url };
  }
  return { persist: true, tool: EXPLICIT_VAULT_SAVE_PRIMITIVE.textOrEmailBody };
}
