import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { CheckCircle2 } from "lucide-react";
import LyknTodosPanel from "@/components/todos/LyknTodosPanel";

// ────────────────────────────────────────────────────────────────────────
// LyknTodosDialog — standalone to-do list pop-up. A thin Dialog wrapper
// around the shared LyknTodosPanel (which also backs the Calendar / To-dos
// toggle inside LyknCalendarDialog).
// ────────────────────────────────────────────────────────────────────────

export default function LyknTodosDialog({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-lg max-h-[88dvh] overflow-hidden flex flex-col sm:w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
            To-do list
          </DialogTitle>
          <DialogDescription>
            Tasks you and LYKN are tracking. Ask LYKN in chat or voice to add, complete, or clear items — they sync here live.
          </DialogDescription>
        </DialogHeader>
        <LyknTodosPanel active={open} />
      </DialogContent>
    </Dialog>
  );
}
