import { useCallback, useEffect, useState } from "react";
import {
  dismissProductUpdate,
  fetchAccountPreferences,
  productUpdateVisible,
  readLocalSeenProductUpdateId,
} from "@/lib/productUpdateClient";
import { PRODUCT_UPDATE, isProductUpdateSeen } from "@/lib/productUpdate";
import { useAuth } from "@/lib/SupabaseAuth";

export function useProductUpdate() {
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(Boolean(user?.id));

  useEffect(() => {
    if (!user?.id) {
      setVisible(false);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    void fetchAccountPreferences()
      .then((prefs) => {
        if (cancelled) return;
        const seenOnAccount = isProductUpdateSeen(prefs?.metadata);
        const seenLocally = readLocalSeenProductUpdateId() === PRODUCT_UPDATE.id;
        if (seenLocally && !seenOnAccount) {
          void dismissProductUpdate(PRODUCT_UPDATE.id);
        }
        setVisible(productUpdateVisible(prefs));
      })
      .catch(() => {
        if (!cancelled) setVisible(productUpdateVisible(null));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const dismiss = useCallback(async () => {
    setVisible(false);
    await dismissProductUpdate(PRODUCT_UPDATE.id);
    return { ok: true };
  }, []);

  return { update: PRODUCT_UPDATE, visible, loading, dismiss };
}
