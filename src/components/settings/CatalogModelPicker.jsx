import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LG_FIELD, LG_SELECT_CONTENT, LG_SELECT_INLINE } from '@/components/settings/glassTokens';

function modelLabel(model) {
  if (!model) return '';
  return model.label || model.id;
}

function containScroll(event) {
  event.stopPropagation();
}

export default function CatalogModelPicker({
  models = [],
  value,
  onSelect,
  onClose,
}) {
  const [q, setQ] = useState('');
  const [provider, setProvider] = useState('all');

  const providers = useMemo(() => {
    const set = new Set(models.map((m) => m.provider).filter(Boolean));
    return ['all', ...[...set].sort()];
  }, [models]);

  const selected = models.find((m) => m.id === value) || null;

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const rows = models.filter((m) => {
      if (provider !== 'all' && m.provider !== provider) return false;
      if (!query) return true;
      return `${m.label} ${m.id} ${m.provider}`.toLowerCase().includes(query);
    });
    rows.sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return String(a.label).localeCompare(String(b.label));
    });
    return rows.slice(0, 80);
  }, [models, provider, q]);

  return (
    <div
      className="border-t border-black/[0.06] bg-black/[0.015] px-3 py-3 dark:border-white/[0.08] dark:bg-white/[0.02]"
      onWheel={containScroll}
    >
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-black/35 dark:text-white/35" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search every model"
            className={`${LG_FIELD} pl-8`}
          />
        </div>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className={`${LG_SELECT_INLINE} w-[7.5rem] min-w-[7.5rem] max-w-[7.5rem] justify-between`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            className={`${LG_SELECT_CONTENT} max-h-56 min-w-[10rem] overflow-y-auto`}
            onWheel={containScroll}
          >
            {providers.map((p) => (
              <SelectItem key={p} value={p}>
                {p === 'all' ? 'All labs' : p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <button
        type="button"
        onClick={() => { onSelect(null); onClose?.(); }}
        className="mt-2 flex w-full items-center justify-between rounded-[10px] px-2.5 py-2 text-left text-[13px] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
      >
        <span className="text-black dark:text-white">LYKN default</span>
        {!value ? <span className="text-[11px] text-black/40 dark:text-white/35">On</span> : null}
      </button>

      <div
        className="mt-1 max-h-[240px] overflow-y-auto overscroll-contain"
        onWheel={containScroll}
      >
        {filtered.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[12px] text-black/40 dark:text-white/35">
            {models.length === 0 ? 'Loading models…' : 'No models match that search.'}
          </p>
        ) : (
          filtered.map((model) => {
            const active = model.id === value;
            return (
              <button
                key={model.id}
                type="button"
                onClick={() => { onSelect(model.id); onClose?.(); }}
                className="flex w-full items-start justify-between gap-3 rounded-[10px] px-2.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-black dark:text-white">
                    {modelLabel(model)}
                  </span>
                  <span className="block truncate text-[11px] text-black/40 dark:text-white/35">
                    {model.id}
                  </span>
                </span>
                <span className="shrink-0 pt-0.5 text-[11px] text-black/35 dark:text-white/30">
                  {active ? 'On' : model.provider}
                </span>
              </button>
            );
          })
        )}
      </div>

      {selected ? (
        <p className="mt-2 px-1 text-[11px] text-black/40 dark:text-white/35">
          Using {modelLabel(selected)}.
        </p>
      ) : null}
    </div>
  );
}
