import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/SupabaseAuth";
import { toast } from "@/components/ui/use-toast";
import { autoImportCloudVaultIfNeeded } from "@/lib/vault/localVaultAutoImport";

/**
 * Kicks off the cloud → local vault self-migration once the user is signed
 * in (see localVaultAutoImport.ts for when it actually does anything). Lives
 * at the app shell so it runs no matter which page the session starts on.
 */
export function useLocalVaultAutoImport() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    const userId = user?.id;
    if (!userId) return;
    void autoImportCloudVaultIfNeeded({
      userId,
      onEvent: (event) => {
        if (event === "started") {
          toast({
            title: "Moving your vault onto this Mac",
            description:
              "Your cloud items are copying down in the background — they'll appear as it finishes.",
          });
          return;
        }
        // "finished": the local store just went from empty to populated, and
        // every mounted vault surface (AI Drive, widgets) cached the empty
        // answer. Invalidate broadly — this is a once-per-account event.
        void queryClient.invalidateQueries();
        toast({
          title: "Your vault is on this Mac",
          description: "Everything copied down. Your files now stay on this device.",
        });
      },
    });
  }, [user?.id, queryClient]);
}

export function LocalVaultAutoImport() {
  useLocalVaultAutoImport();
  return null;
}
