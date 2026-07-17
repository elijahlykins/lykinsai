export const STEWARD_EXECUTION_KINDS = ['research', 'code', 'agent'];

export const EXECUTION_KIND_LABELS = {
  research: 'Research',
  code: 'Cursor build',
  agent: 'Sub-agent',
};

export const NIGHT_SHIFT_TIERS = ['brief', 'research', 'delegate'];

/** @param {string|null|undefined} raw */
export function parseNightShiftTier(raw) {
  const t = String(raw || '').trim();
  if (t === 'research' || t === 'delegate') return t;
  return 'brief';
}

/** @param {string|null|undefined} raw */
export function parseExecutionKind(raw) {
  const k = String(raw || '').trim();
  if (k === 'code' || k === 'agent') return k;
  return 'research';
}
