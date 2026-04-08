import React, { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { UserRound } from 'lucide-react';
import { useAuth } from '@/lib/SupabaseAuth';
import { useIntake } from '@/context/IntakeContext';
import { submitSynthesisIntake } from '@/lib/synthesis/intakeApi';
import {
  emptyIntakeAnswers,
  loadStoredIntakeAnswers,
  saveStoredIntakeAnswers,
} from '@/lib/synthesis/intakeStorage';
import { toast } from '@/components/ui/use-toast';

const FIELDS = [
  { key: 'role', label: 'What kind of work do you do?' },
  { key: 'focus', label: 'What are you currently building or focused on?' },
  { key: 'tools', label: 'What tools or systems do you use most?' },
  { key: 'constraints', label: 'Any context I should know? (team size, goals, stack)' },
  { key: 'thinkingStyle', label: 'How do you like to think through problems? (optional)' },
];

export default function AboutYouSection({ isOpen }) {
  const { user } = useAuth();
  const { refreshProfileStatus, assumeIntakeCompleted } = useIntake();
  const [answers, setAnswers] = useState(() => emptyIntakeAnswers());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen || !user?.id) return;
    void refreshProfileStatus();
    setAnswers(loadStoredIntakeAnswers(user.id));
  }, [isOpen, user?.id, refreshProfileStatus]);

  const anyFilled = FIELDS.some(({ key }) => String(answers[key] || '').trim().length > 0);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!anyFilled) {
      toast({
        title: 'Add at least one answer',
        description: 'Fill in one or more fields before saving.',
        variant: 'destructive',
      });
      return;
    }
    setSubmitting(true);
    try {
      await submitSynthesisIntake(answers, { force: true });
      if (user?.id) saveStoredIntakeAnswers(user.id, answers);
      assumeIntakeCompleted();
      try {
        await refreshProfileStatus();
      } catch (refreshErr) {
        console.warn('[Intake] status refresh after settings submit (non-fatal):', refreshErr);
      }
      toast({
        title: 'Profile updated',
        description: 'Your workspace model has been refreshed.',
      });
    } catch (err) {
      toast({
        title: 'Could not update',
        description: err?.message || 'Try again later.',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!user) return null;

  return (
    <div className="p-4 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded-xl border border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
          <UserRound className="w-5 h-5 text-gray-600 dark:text-gray-300" />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-black dark:text-white">About you</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Personalize how LYKN understands your role, tools, and goals. Updating here refreshes your synthesis profile.
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        {FIELDS.map(({ key, label }) => (
          <div key={key} className="space-y-1">
            <Label className="text-xs text-gray-700 dark:text-gray-300">{label}</Label>
            <Textarea
              value={answers[key]}
              onChange={(ev) => setAnswers((a) => ({ ...a, [key]: ev.target.value }))}
              rows={key === 'thinkingStyle' ? 2 : 3}
              className="resize-none text-sm bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 text-black dark:text-white"
            />
          </div>
        ))}
        <Button
          type="submit"
          disabled={submitting}
          className="w-full bg-blue-500 hover:bg-blue-600 text-white"
        >
          {submitting ? 'Saving…' : 'Save profile'}
        </Button>
      </form>
    </div>
  );
}
