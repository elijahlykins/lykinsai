// Bridges main-process Routine/Task notifications into the renderer: every
// notification lands as an in-app toast (the native desktop notification is
// main's job; this covers the user already in the app).
// Mounted once next to <Toaster /> in App.jsx; renders nothing itself.
import { useEffect } from "react";
import { toast } from "@/components/ui/use-toast";

type ActivityNotification = {
  title?: string;
  body?: string;
  urgency?: string;
};

type Lykn = {
  desktop?: boolean;
  onActivityNotification?: (cb: (p: ActivityNotification) => void) => () => void;
};

const lykn = (): Lykn => (typeof window !== "undefined" ? ((window as { lykn?: Lykn }).lykn ?? {}) : {});

export default function ActivityNotificationBridge() {
  useEffect(() => {
    const l = lykn();
    if (!l.desktop || typeof l.onActivityNotification !== "function") return;
    return l.onActivityNotification((note) => {
      if (!note?.title) return;
      toast({
        title: note.title,
        description: note.body || undefined,
        ...(note.urgency === "high" ? { variant: "destructive" } : {}),
      });
    });
  }, []);
  return null;
}
