import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/SupabaseAuth';
import { fetchSynthesisProfileStatus } from '@/lib/synthesis/intakeApi';

const IntakeContext = createContext(null);

const STATUS_ATTEMPTS = 3;
/** ms between attempts after the first failure */
const STATUS_RETRY_DELAYS_MS = [800, 2200];

function sessionSkipKey(userId) {
  return `lykn_intake_skipped_${userId}`;
}

export function IntakeProvider({ children }) {
  const { user, loading: authLoading } = useAuth();
  const [profileStatus, setProfileStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [sessionSkipped, setSessionSkipped] = useState(false);

  useEffect(() => {
    if (!user?.id) {
      setSessionSkipped(false);
      return;
    }
    try {
      setSessionSkipped(sessionStorage.getItem(sessionSkipKey(user.id)) === '1');
    } catch {
      setSessionSkipped(false);
    }
  }, [user?.id]);

  const refreshProfileStatus = useCallback(async () => {
    if (!user?.id) {
      setProfileStatus(null);
      setStatusError(false);
      return;
    }
    setStatusLoading(true);
    setStatusError(false);
    let lastErr;
    for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = STATUS_RETRY_DELAYS_MS[attempt - 1] ?? 2000;
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        const data = await fetchSynthesisProfileStatus();
        setProfileStatus(data);
        setStatusError(false);
        setStatusLoading(false);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    if (import.meta.env.DEV) console.warn('[Intake] profile status failed after retries:', lastErr);
    setStatusError(true);
    setProfileStatus(null);
    setStatusLoading(false);
  }, [user?.id]);

  /** After successful POST /intake, close the modal even if a follow-up GET is slow or fails briefly. */
  const assumeIntakeCompleted = useCallback(() => {
    setStatusError(false);
    setProfileStatus((prev) => ({
      intake_completed_at: new Date().toISOString(),
      has_narrative: prev?.has_narrative ?? true,
    }));
  }, []);

  const statusErrorRef = useRef(false);
  statusErrorRef.current = statusError;

  useEffect(() => {
    if (!user?.id || authLoading) return;
    void refreshProfileStatus();
  }, [user?.id, authLoading, refreshProfileStatus]);

  /** Transient failures: retry when the tab becomes visible or the network returns. */
  useEffect(() => {
    if (!user?.id || authLoading) return;
    const retry = () => {
      if (document.visibilityState !== 'visible') return;
      if (!statusErrorRef.current) return;
      void refreshProfileStatus();
    };
    const onOnline = () => {
      if (statusErrorRef.current) void refreshProfileStatus();
    };
    document.addEventListener('visibilitychange', retry);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('online', onOnline);
    };
  }, [user?.id, authLoading, refreshProfileStatus]);

  const skipForSession = useCallback(() => {
    if (!user?.id) return;
    try {
      sessionStorage.setItem(sessionSkipKey(user.id), '1');
    } catch {
      /* ignore */
    }
    setSessionSkipped(true);
  }, [user?.id]);

  const showIntakeModal = Boolean(
    user &&
      !authLoading &&
      !statusLoading &&
      !statusError &&
      profileStatus &&
      profileStatus.intake_completed_at == null &&
      !sessionSkipped,
  );

  const value = useMemo(
    () => ({
      profileStatus,
      statusLoading,
      statusError,
      refreshProfileStatus,
      assumeIntakeCompleted,
      skipForSession,
      showIntakeModal,
    }),
    [profileStatus, statusLoading, statusError, refreshProfileStatus, assumeIntakeCompleted, skipForSession, showIntakeModal],
  );

  return <IntakeContext.Provider value={value}>{children}</IntakeContext.Provider>;
}

export function useIntake() {
  const ctx = useContext(IntakeContext);
  if (!ctx) {
    throw new Error('useIntake must be used within IntakeProvider');
  }
  return ctx;
}
