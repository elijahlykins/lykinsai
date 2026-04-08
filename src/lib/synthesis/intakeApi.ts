import { API_BASE_URL } from '@/lib/api-config';
import type { IntakeAnswers } from '@/lib/synthesis/intakeStorage';

export type SynthesisProfileStatus = {
  intake_completed_at: string | null;
  has_narrative: boolean;
};

async function readApiError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw) as { error?: string };
    if (j?.error && typeof j.error === 'string') return j.error;
  } catch {
    /* ignore */
  }
  return raw.slice(0, 200) || res.statusText;
}

export async function fetchSynthesisProfileStatus(): Promise<SynthesisProfileStatus> {
  const res = await fetch(`${API_BASE_URL}/api/synthesis/profile/status`);
  if (!res.ok) {
    const msg = await readApiError(res);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function submitSynthesisIntake(
  answers: IntakeAnswers,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; updated?: boolean; reason?: string }> {
  const res = await fetch(`${API_BASE_URL}/api/synthesis/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers, force: Boolean(opts?.force) }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; updated?: boolean; reason?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}
