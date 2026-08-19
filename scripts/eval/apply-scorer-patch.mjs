#!/usr/bin/env node
// Usage: node scripts/eval/apply-scorer-patch.mjs <src-file> <dest-file>
// Copies the upstream scorer and inserts the pinned-key-points lookup.
// Idempotent, and refuses rather than guessing if the anchor has moved.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ANCHOR = 'async def identify_key_points(task, model):';
const MARK = '# --- lykn harness: pinned key points';
const INSERT = `    ${MARK} (see patches/pinned-key-points.py.patch)
    import os as _os, json as _json
    _kp_path = _os.environ.get("LYKN_KEYPOINTS", "")
    if _kp_path and _os.path.exists(_kp_path):
        try:
            with open(_kp_path, "r") as _f:
                _kp = _json.load(_f).get("byTask", {})
            _hit = _kp.get(str(task).strip())
            if _hit:
                return "**Key Points**:\\n" + _hit
        except Exception:
            pass  # a broken cache must fall through to generation, never fail the run
    # --- end lykn harness
`;

const [src, dest] = process.argv.slice(2);
if (!src || !dest) { console.error('usage: apply-scorer-patch.mjs <src> <dest>'); process.exit(2); }

const text = await readFile(src, 'utf8');
if (text.includes(MARK)) {
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, text);
  console.log('already patched');
  process.exit(0);
}
const i = text.indexOf(ANCHOR);
if (i < 0) {
  console.error(`Anchor not found in ${src}:\n  ${ANCHOR}`);
  console.error('The upstream scorer changed. Re-read it and update the patch rather than guessing.');
  process.exit(1);
}
const cut = i + ANCHOR.length;
const patched = `${text.slice(0, cut)}\n${INSERT}${text.slice(cut)}`;
await mkdir(path.dirname(dest), { recursive: true });
await writeFile(dest, patched);
console.log(`patched -> ${dest}`);
