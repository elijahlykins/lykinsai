export const VAULT_PICKER_CHANGE = "lykn-vault-picker-change";
export const VAULT_PICKER_SET_SELECTION = "lykn-vault-picker-set-selection";

/** @param {string} origin */
export function isTrustedVaultPickerOrigin(origin) {
  try {
    return origin === window.location.origin;
  } catch {
    return false;
  }
}
