import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { fetchModelCatalog } from '@/lib/models/modelPlatformClient';

export default function ModelExplorer({ open, onOpenChange, onPick, modelTier }) {
  const [models, setModels] = useState([]);
  const [q, setQ] = useState('');
  const [provider, setProvider] = useState('all');

  useEffect(() => {
    if (!open) return;
    fetchModelCatalog('?visibility=catalog')
      .then((data) => setModels(Array.isArray(data.models) ? data.models : []))
      .catch(() => setModels([]));
  }, [open]);

  const providers = useMemo(() => {
    const set = new Set(models.map((m) => m.provider).filter(Boolean));
    return ['all', ...[...set].sort()];
  }, [models]);

  const filtered = models.filter((m) => {
    if (provider !== 'all' && m.provider !== provider) return false;
    if (q && !`${m.label} ${m.id}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <div className="border-b border-black/8 px-4 py-3 dark:border-white/10">
          <DialogTitle className="text-[15px] font-medium">More models</DialogTitle>
          <p className="mt-1 text-[12px] text-black/45 dark:text-white/40">
            Recommended models stay in the chat picker. This is the full catalog.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search models"
              className="h-8 flex-1 rounded-[10px] bg-black/[0.04] px-2.5 text-[13px] outline-none dark:bg-white/[0.06]"
            />
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="h-8 rounded-[10px] bg-black/[0.04] px-2 text-[13px] dark:bg-white/[0.06]"
            >
              {providers.map((p) => (
                <option key={p} value={p}>{p === 'all' ? 'All providers' : p}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-black/40 dark:text-white/35">
              {modelTier === 'basic' ? 'Upgrade to browse more models.' : 'No catalog models yet.'}
            </p>
          ) : (
            filtered.slice(0, 80).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { onPick?.(m.id); onOpenChange(false); }}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-black dark:text-white">{m.label}</span>
                  <span className="block truncate text-[11px] text-black/40 dark:text-white/35">{m.id}</span>
                </span>
                <span className="shrink-0 text-[11px] text-black/35 dark:text-white/30">{m.provider}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
