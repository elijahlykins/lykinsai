/** Persist last submitted intake answers for Settings → About you (per user). */

export type IntakeAnswers = {
  role: string;
  focus: string;
  tools: string;
  constraints: string;
  thinkingStyle: string;
};

export function emptyIntakeAnswers(): IntakeAnswers {
  return { role: '', focus: '', tools: '', constraints: '', thinkingStyle: '' };
}

export function intakeAnswersStorageKey(userId: string) {
  return `lykn_intake_last_answers_${userId}`;
}

export function loadStoredIntakeAnswers(userId: string | undefined): IntakeAnswers {
  if (!userId || typeof localStorage === 'undefined') return emptyIntakeAnswers();
  try {
    const raw = localStorage.getItem(intakeAnswersStorageKey(userId));
    if (!raw) return emptyIntakeAnswers();
    const p = JSON.parse(raw) as Partial<IntakeAnswers>;
    return { ...emptyIntakeAnswers(), ...p };
  } catch {
    return emptyIntakeAnswers();
  }
}

export function saveStoredIntakeAnswers(userId: string | undefined, answers: IntakeAnswers) {
  if (!userId || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(intakeAnswersStorageKey(userId), JSON.stringify(answers));
  } catch {
    /* ignore quota */
  }
}
