import { useCallback, useEffect, useRef, useState } from "react";
import {
  findSlashPathToken,
  rankSlashPathItems,
  replaceSlashPathToken,
  splitSlashPathQuery,
  type SlashPathItem,
  type SlashPathToken,
} from "@/lib/chat/slashPathQuery";
import { findSlashModelToken } from "@/lib/chat/slashModelQuery";
import { findSlashAppToken } from "@/lib/chat/slashAppQuery";
import { lookupSlashPath, slashPathAvailable } from "@/lib/chat/slashPathLookup";

const LOOKUP_MS = 32;
const LIST_CAP = 80;
const POOL_CAP = 400;

export type SlashPathMentionState = {
  open: boolean;
  items: SlashPathItem[];
  index: number;
  hint: string;
  setIndex: (index: number) => void;
  onInput: (textarea: HTMLTextAreaElement) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  pick: (item: SlashPathItem, mode: "attach" | "descend") => void;
  close: () => void;
};

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

function universeKey(raw: string): string {
  const split = splitSlashPathQuery(raw);
  return `${split.useRoots ? "1" : "0"}:${split.dir}`;
}

function mergePool(prev: SlashPathItem[], incoming: SlashPathItem[]): SlashPathItem[] {
  const seen = new Set(prev.map((item) => item.path));
  const out = prev.slice();
  for (const item of incoming) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
    if (out.length >= POOL_CAP) break;
  }
  return out;
}

export function useSlashPathMention({
  enabled,
  onValue,
  onAttachPaths,
}: {
  enabled: boolean;
  onValue: (value: string) => void;
  onAttachPaths?: (paths: string[]) => void | Promise<void>;
}): SlashPathMentionState {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SlashPathItem[]>([]);
  const [index, setIndex] = useState(0);
  const [hint, setHint] = useState("");
  const tokenRef = useRef<SlashPathToken | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const seqRef = useRef(0);
  const timerRef = useRef<number>(0);
  const universeRef = useRef<{ key: string; items: SlashPathItem[] }>({ key: "", items: [] });

  const close = useCallback(() => {
    window.clearTimeout(timerRef.current);
    seqRef.current += 1;
    tokenRef.current = null;
    setOpen(false);
    setItems([]);
    setHint("");
    setIndex(0);
  }, []);

  const showRanked = useCallback((pool: SlashPathItem[], filter: string, emptyHint: string) => {
    const next = rankSlashPathItems(pool, filter).slice(0, LIST_CAP);
    setItems(next);
    setIndex((i) => (next.length ? Math.min(i, next.length - 1) : 0));
    setOpen(true);
    if (next.length) setHint("");
    else if (emptyHint) setHint(emptyHint);
  }, []);

  const runLookup = useCallback(
    async (token: SlashPathToken, textarea: HTMLTextAreaElement) => {
      const seq = ++seqRef.current;
      const result = await lookupSlashPath(token.raw);
      if (seq !== seqRef.current || textareaRef.current !== textarea) return;
      tokenRef.current = token;
      const key = universeKey(token.raw);
      const incoming = result.pool ?? result.items;
      if (universeRef.current.key === key) {
        universeRef.current = { key, items: mergePool(universeRef.current.items, incoming) };
      } else {
        universeRef.current = { key, items: incoming.slice(0, POOL_CAP) };
      }
      const split = splitSlashPathQuery(token.raw);
      let emptyHint = "";
      if (result.error === "local_mode_off") {
        emptyHint = "Turn on Local Mode in Settings to link files from this Mac.";
        universeRef.current = { key: "", items: [] };
      } else if (result.error === "not_synced") {
        emptyHint = "That folder is not in LYKN's synced locations.";
      } else if (result.error === "unavailable") {
        emptyHint = "File linking is available in the LYKN desktop app.";
      } else if (!result.items.length) {
        emptyHint = "No matching files or folders.";
      }
      showRanked(universeRef.current.items, split.filter, emptyHint);
    },
    [showRanked],
  );

  const onInput = useCallback(
    (textarea: HTMLTextAreaElement) => {
      textareaRef.current = textarea;
      if (!enabled || !slashPathAvailable() || typeof onAttachPaths !== "function") {
        close();
        return;
      }
      const cursor = textarea.selectionStart ?? textarea.value.length;
      const token = findSlashPathToken(textarea.value, cursor);
      if (
        !token ||
        findSlashModelToken(textarea.value, cursor) ||
        findSlashAppToken(textarea.value, cursor)
      ) {
        close();
        return;
      }
      tokenRef.current = token;
      const split = splitSlashPathQuery(token.raw);
      const key = universeKey(token.raw);
      if (universeRef.current.key === key && universeRef.current.items.length) {
        showRanked(universeRef.current.items, split.filter, "");
      } else {
        setOpen(true);
      }
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        void runLookup(token, textarea);
      }, LOOKUP_MS);
    },
    [close, enabled, onAttachPaths, runLookup, showRanked],
  );

  const pick = useCallback(
    (item: SlashPathItem, mode: "attach" | "descend") => {
      const textarea = textareaRef.current;
      const token = tokenRef.current;
      if (!textarea || !token) return;
      if (mode === "descend" && item.kind === "folder") {
        const insert = item.path.endsWith("/") ? item.path : `${item.path}/`;
        const next = replaceSlashPathToken(textarea.value, token, insert);
        writeTextarea(textarea, next, token.start + insert.length, onValue);
        const nextToken = { start: token.start, end: token.start + insert.length, raw: insert };
        tokenRef.current = nextToken;
        universeRef.current = { key: "", items: [] };
        void runLookup(nextToken, textarea);
        return;
      }
      const next = replaceSlashPathToken(textarea.value, token, "");
      const cursor = Math.min(token.start, next.length);
      writeTextarea(textarea, next, cursor, onValue);
      close();
      void onAttachPaths?.([item.path]);
      textarea.focus();
    },
    [close, onAttachPaths, onValue, runLookup],
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
      if (event.key === "Tab") {
        const item = items[index];
        if (!item) return false;
        event.preventDefault();
        pick(item, item.kind === "folder" ? "descend" : "attach");
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const item = items[index];
        if (!item) return false;
        event.preventDefault();
        pick(item, "attach");
        return true;
      }
      return false;
    },
    [close, index, items, open, pick],
  );

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      seqRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (textareaRef.current?.contains(target)) return;
      const el = target instanceof Element ? target : target?.parentElement;
      if (el?.closest('[aria-label="Link a file or folder"]')) return;
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
    pick,
    close,
  };
}
