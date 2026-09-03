import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Save } from 'lucide-react';

import { supabase } from '@/lib/supabase';

import { WidgetFrame, WidgetHeader } from './shared';

/**
 * A scratchpad that lives on the desktop. Typing is local and instant — the
 * draft is kept per widget so two notes on the desktop are two notes — and
 * Save files it in the Vault as a plain note, the same shape the chat's Quick
 * Note makes.
 */

const draftKey = (id) => `lykn_widget_note_${id}`;

function readDraft(id) {
  try {
    return localStorage.getItem(draftKey(id)) || '';
  } catch {
    return '';
  }
}

export default function QuickNoteWidget({ id, userId, size = 'small', onOpen }) {
  const [text, setText] = useState(() => readDraft(id));
  const [state, setState] = useState('idle'); // idle | saving | saved
  const saveTimer = useRef(null);

  // Persist the draft lazily; a desktop note shouldn't hit storage per keypress.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (text) localStorage.setItem(draftKey(id), text);
        else localStorage.removeItem(draftKey(id));
      } catch {
        /* the draft just won't survive a reload */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [id, text]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const save = useCallback(async () => {
    const content = text.trim();
    if (!content || state === 'saving') return;
    if (!userId) {
      onOpen?.('vault');
      return;
    }
    setState('saving');
    const title = content.split('\n')[0].slice(0, 60) || 'Quick Note';
    const row = { user_id: userId, title, content };
    try {
      let { error } = await supabase
        .from('vault_items')
        .insert({ ...row, source: 'quick_note' })
        .select('id')
        .single();
      // Older schemas have no `source` column — the note still belongs in the
      // vault, so retry without it rather than losing what was typed.
      if (error) {
        ({ error } = await supabase.from('vault_items').insert(row).select('id').single());
      }
      if (error) {
        setState('idle');
        return;
      }
      setText('');
      setState('saved');
      saveTimer.current = setTimeout(() => setState('idle'), 1600);
    } catch {
      setState('idle');
    }
  }, [text, state, userId, onOpen]);

  const saveIcon =
    state === 'saving' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    ) : state === 'saved' ? (
      <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
    ) : (
      <Save className="h-3.5 w-3.5" />
    );

  return (
    <WidgetFrame className="flex flex-col p-3.5">
      <WidgetHeader
        label={state === 'saved' ? 'Saved to Vault' : 'Note'}
        tone={state === 'saved' ? 'text-emerald-500' : 'text-yellow-500'}
        onClick={() => onOpen?.('vault')}
        action={
          <button
            type="button"
            onClick={save}
            disabled={!text.trim() || state === 'saving'}
            title="Save to Vault"
            aria-label="Save to Vault"
            className="flex flex-shrink-0 items-center justify-center text-black/70 transition-transform hover:scale-110 active:scale-95 disabled:opacity-30 disabled:hover:scale-100 dark:text-white"
          >
            {saveIcon}
          </button>
        }
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        placeholder={size === 'small' ? 'Jot something…' : 'Jot something down. ⌘↵ files it in the Vault.'}
        spellCheck={false}
        className="mt-1.5 min-h-0 w-full flex-1 resize-none bg-transparent text-[0.72rem] leading-relaxed text-black/85 outline-none placeholder:text-black/35 dark:text-white/90 dark:placeholder:text-white/30"
      />
    </WidgetFrame>
  );
}
