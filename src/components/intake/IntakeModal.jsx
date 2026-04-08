import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  { key: 'role', label: 'What kind of work do you do?', optional: false },
  { key: 'focus', label: 'What are you currently building or focused on?', optional: false },
  { key: 'tools', label: 'What tools or systems do you use most?', optional: false },
  { key: 'constraints', label: 'Any context I should know? (team size, goals, stack)', optional: false },
  { key: 'thinkingStyle', label: 'How do you like to think through problems?', optional: true },
];

export default function IntakeModal() {
  const { user } = useAuth();
  const { showIntakeModal, skipForSession, refreshProfileStatus, assumeIntakeCompleted } = useIntake();
  const [answers, setAnswers] = useState(() => emptyIntakeAnswers());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (showIntakeModal && user?.id) {
      setAnswers(loadStoredIntakeAnswers(user.id));
      setError(null);
    }
  }, [showIntakeModal, user?.id]);

  const handleOpenChange = (open) => {
    if (!open) skipForSession();
  };

  const onSubmit = async (e) => {
    e?.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await submitSynthesisIntake(answers, { force: false });
      if (user?.id) saveStoredIntakeAnswers(user.id, answers);
      assumeIntakeCompleted();
      try {
        await refreshProfileStatus();
      } catch (refreshErr) {
        console.warn('[Intake] status refresh after submit (non-fatal):', refreshErr);
      }
      toast({
        title: "You're set",
        description: "I'll use this to personalize your workspace.",
      });
    } catch (err) {
      const msg = err?.message || 'Something went wrong. Try again.';
      setError(msg);
      toast({ title: 'Could not save', description: msg, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const anyFilled = FIELDS.some(({ key }) => String(answers[key] || '').trim().length > 0);

  return (
    <Dialog open={showIntakeModal} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-white dark:bg-[#171515] border border-gray-200 dark:border-gray-700 text-black dark:text-white sm:max-w-lg z-[110]">
        <DialogHeader>
          <DialogTitle className="text-black dark:text-white">Tell us about you</DialogTitle>
          <DialogDescription className="text-gray-600 dark:text-gray-400">
            A few quick answers help LYKN tailor tone and context. You can skip and fill this in Settings later.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4 py-2">
          {FIELDS.map(({ key, label, optional }) => (
            <div key={key} className="space-y-1.5">
              <Label className="text-sm text-gray-900 dark:text-gray-100">
                {label}
                {optional ? (
                  <span className="text-gray-400 dark:text-gray-500 font-normal"> (optional)</span>
                ) : null}
              </Label>
              <Textarea
                value={answers[key]}
                onChange={(ev) => setAnswers((a) => ({ ...a, [key]: ev.target.value }))}
                rows={optional ? 2 : 3}
                placeholder=""
                className="resize-none bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-600 text-black dark:text-white"
              />
            </div>
          ))}

          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

          <DialogFooter className="flex-col sm:flex-row gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              className="w-full sm:w-auto"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Skip for now
            </Button>
            <Button
              type="submit"
              className="w-full sm:w-auto bg-blue-500 hover:bg-blue-600 text-white"
              disabled={submitting || !anyFilled}
            >
              {submitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
