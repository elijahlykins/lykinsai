// Bridges main-process Bot/Routine notifications into the renderer:
//  - every notification also lands as an in-app toast (the native desktop
//    notification is main's job; this covers the user already in the app);
//  - a native-notification click arrives as lykn:activity-open with the
//    deep-link identity, and hops to the owning Bot's chat board through the
//    same event HomeChatBar uses.
// Mounted once next to <Toaster /> in App.jsx; renders nothing itself.
import { useEffect } from "react";
import { toast } from "@/components/ui/use-toast";
import {
  onActivityNotification,
  onActivityOpen,
  routinesAvailable,
} from "@/lib/routines/routinesClient";

export default function ActivityNotificationBridge() {
  useEffect(() => {
    if (!routinesAvailable()) return;
    const offNotify = onActivityNotification((note) => {
      if (!note?.title) return;
      toast({
        title: note.title,
        description: note.body || undefined,
        ...(note.urgency === "high" ? { variant: "destructive" } : {}),
      });
    });
    const offOpen = onActivityOpen((deepLink) => {
      const botId = String(deepLink?.botId || "");
      if (!botId) return;
      // Same hop HomeChatBar performs: park for a cold surface, event for a
      // warm one (useBotChatBridge listens for both).
      const detail = { botId, chatId: "", at: Date.now() };
      try {
        sessionStorage.setItem("lykn_pending_bot_open", JSON.stringify(detail));
      } catch {
        /* the event below still covers a warm chat surface */
      }
      window.dispatchEvent(new CustomEvent("lykn-bot-chat-open", { detail }));
    });
    return () => {
      offNotify();
      offOpen();
    };
  }, []);
  return null;
}
