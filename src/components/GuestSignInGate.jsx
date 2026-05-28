import React, { useEffect, useState } from "react";
import { useAuth } from "@/lib/SupabaseAuth";
import SignInActionBlocker from "@/components/SignInActionBlocker";
import {
  GUEST_SIGN_IN_REQUIRED_EVENT,
  guestSubtitleForReason,
} from "@/lib/guestChatLimits";

/**
 * Global full-screen sign-in wall for logged-out users who hit guest
 * limits (message cap, second chat, new-chat buttons).
 */
export default function GuestSignInGate() {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [subtitle, setSubtitle] = useState(() => guestSubtitleForReason("chat"));

  useEffect(() => {
    if (loading || user) {
      setOpen(false);
      return undefined;
    }
    const onRequired = (e) => {
      const reason = e?.detail?.reason || "chat";
      setSubtitle(guestSubtitleForReason(reason));
      setOpen(true);
    };
    window.addEventListener(GUEST_SIGN_IN_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(GUEST_SIGN_IN_REQUIRED_EVENT, onRequired);
  }, [loading, user]);

  if (loading || user) return null;

  return (
    <SignInActionBlocker
      open={open}
      onClose={() => setOpen(false)}
      subtitle={subtitle}
    />
  );
}
