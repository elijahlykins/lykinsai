import { useCallback, useEffect, useRef, useState } from "react";
import { replaceSlashPathToken, type SlashPathItem } from "@/lib/chat/slashPathQuery";
import {
  findSlashModelToken,
  openStudioModelPicker,
  rankSlashModelOptions,
  slashModelMenuItems,
  type SlashModelOption,
} from "@/lib/chat/slashModelQuery";

function writeTextarea(
  textarea: HTMLTextAreaElement,
  next: string,
  cursor: number,
  onValue: (value: string) => void,
) {
  onValue(next);
  const apply = () => {
    if (textarea.value !== next) textarea.value = next;
    textarea.setSelectionRange(cursor, cursor);
  };
  apply();
  requestAnimationFrame(apply);
}

export function useSlashModelMention({
  enabled,
  onValue,
  onSelect,
  options,
}: {
  enabled: boolean;
  onValue: (value: string) => void;
  onSelect?: (value: string) => void;
  options: SlashModelOption[];
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SlashPathItem[]>([]);
  const [index, setIndex] = useState(0);
  const [hint, setHint] = useState("");
  const tokenRef = useRef<ReturnType<typeof findSlashModelToken>>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const close = useCallback(() => {
    tokenRef.current = null;
    setOpen(false);
    setItems([]);
    setHint("");
    setIndex(0);
  }, []);

  const showQuery = useCallback((query: string) => {
    const ranked = rankSlashModelOptions(optionsRef.current, query);
    const next = slashModelMenuItems(ranked);
    setItems(next);
    setIndex((i) => (next.length ? Math.min(i, next.length - 1) : 0));
    setOpen(true);
    if (!next.length) setHint("No matching models.");
    else setHint("");
  }, []);

  const onInput = useCallback(
    (textarea: HTMLTextAreaElement) => {
      textareaRef.current = textarea;
      if (!enabled || typeof onSelect !== "function") {
        close();
        return;
      }
      const token = findSlashModelToken(
        textarea.value,
        textarea.selectionStart ?? textarea.value.length,
      );
      if (!token) {
        close();
        return;
      }
      tokenRef.current = token;
      if (token.kind === "picker") {
        const next = replaceSlashPathToken(textarea.value, token, "");
        const cursor = Math.min(token.start, next.length);
        writeTextarea(textarea, next, cursor, onValue);
        close();
        openStudioModelPicker();
        textarea.focus();
        return;
      }
      showQuery(token.query);
    },
    [close, enabled, onSelect, showQuery],
  );

  const pick = useCallback(
    (item: SlashPathItem) => {
      const textarea = textareaRef.current;
      const token = tokenRef.current;
      if (!textarea || !token) return;
      if (item.locked) {
        setHint("That model isn't available on your current plan.");
        return;
      }
      const next = replaceSlashPathToken(textarea.value, token, "");
      const cursor = Math.min(token.start, next.length);
      writeTextarea(textarea, next, cursor, onValue);
      close();
      onSelect?.(item.path);
      textarea.focus();
    },
    [close, onSelect, onValue],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      if (event.key === "ArrowDown") {
        if (!items.length) return false;
        event.preventDefault();
        setIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        if (!items.length) return false;
        event.preventDefault();
        setIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        const item = items[index];
        if (!item) return false;
        event.preventDefault();
        pick(item);
        return true;
      }
      return false;
    },
    [close, index, items, open, pick],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (textareaRef.current?.contains(target)) return;
      const el = target instanceof Element ? target : target?.parentElement;
      if (el?.closest('[aria-label="Choose a model"]')) return;
      close();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [close, open]);

  return {
    open,
    items,
    index,
    hint,
    setIndex,
    onInput,
    onKeyDown,
    pick: (item) => pick(item),
    close,
  };
}

export type { SlashModelOption };
