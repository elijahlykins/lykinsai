import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { SIGNUP_GRANT_NOTICE_COPY } from "../../lib/billing/signupGrantNotice.js";
import { SIGNUP_GRANT_USD } from "../../lib/billing/planCatalog.js";
import {
  dismissSignupGrantNotice,
  readLocalSignupGrantNoticeSeen,
  signupGrantNoticeVisible,
} from "@/lib/signupGrantNoticeClient";

async function fetchBilling() {
  const res = await fetch(`${API_BASE_URL}/api/billing/me`);
  if (!res.ok) throw new Error(`billing/me ${res.status}`);
  return res.json();
}

export function useSignupGrantNotice() {
  const { user } = useAuth();
  const userId = user?.id;
  const [dismissed, setDismissed] = useState(false);

  const { data } = useQuery({
    queryKey: ["billing-me", userId || "guest"],
    queryFn: fetchBilling,
    enabled: Boolean(userId),
    staleTime: 5_000,
    gcTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    setDismissed(readLocalSignupGrantNoticeSeen(userId));
  }, [userId]);

  const dismiss = useCallback(async () => {
    setDismissed(true);
    await dismissSignupGrantNotice(userId);
    return { ok: true };
  }, [userId]);

  return {
    copy: SIGNUP_GRANT_NOTICE_COPY,
    amountUsd: data?.signup_grant_usd || SIGNUP_GRANT_USD,
    visible: Boolean(userId) && !dismissed && signupGrantNoticeVisible(data, userId),
    dismiss,
  };
}
