import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fetchModelCatalog, fetchModelSettings, saveModelSettings } from '@/lib/models/modelPlatformClient';
import { readLocalModelSetup } from '@/lib/models/modelSetupStore';
import { ROUTE_CATEGORIES } from '@/lib/models/routeCategories';
import { LG_INLINE_W } from '@/components/settings/glassTokens';
import CatalogModelPicker from '@/components/settings/CatalogModelPicker';

const CATEGORIES = [
  { id: 'default', label: 'Default chat', hint: 'Everyday questions and writing.' },
  { id: 'quick', label: 'Quick', hint: 'Short answers where speed matters.' },
  { id: 'reasoning', label: 'Reasoning', hint: 'Hard problems and long thinking.' },
  { id: 'coding', label: 'Coding', hint: 'Artifacts, apps, and code edits.' },
  { id: 'vision', label: 'Vision', hint: 'Images, screenshots, and pages.' },
  { id: 'research', label: 'Research', hint: 'Deep research and long sources.' },
  { id: 'agents', label: 'Agents', hint: 'Bots and multi-step agent work.' },
];

function modelName(models, id) {
  if (!id) return 'LYKN default';
  const found = models.find((m) => m.id === id);
  return found?.label || id;
}

export default function ModelRoutingSettings({ children }) {
  const initial = readLocalModelSetup();
  const [mode, setMode] = useState(initial.mode);
  const [categories, setCategories] = useState(initial.categories);
  const [models, setModels] = useState([]);
  const [openCategory, setOpenCategory] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchModelSettings()
      .then((data) => {
        if (cancelled) return;
        setMode(data.settings?.mode || 'lykn');
        setCategories(data.settings?.categories || {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (mode !== 'my_setup') return undefined;
    let cancelled = false;
    setLoadingCatalog(true);
    fetchModelCatalog()
      .then((data) => {
        if (cancelled) return;
        setModels(Array.isArray(data.models) ? data.models : []);
        if (data.catalog?.ok === false) {
          setStatus('Could not refresh the full catalog. Showing what LYKN already knows.');
        } else {
          setStatus('');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('Could not load models. Check that you are signed in.');
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false);
      });
    return () => { cancelled = true; };
  }, [mode]);

  const persist = async (patch) => {
    const data = await saveModelSettings(patch);
    setMode(data.settings?.mode || patch.mode);
    setCategories(data.settings?.categories || patch.categories || {});
  };

  const chooseMode = (nextMode) => {
    setMode(nextMode);
    if (nextMode === 'lykn') setOpenCategory(null);
    try {
      const raw = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      raw.aiModel = nextMode === 'my_setup' ? 'lykn-setup' : 'lykn';
      localStorage.setItem('lykinsai_settings', JSON.stringify(raw));
      window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
    } catch {
      /* picker stays on its current value */
    }
    void persist({ mode: nextMode, categories });
  };

  const chooseModel = (category, modelId) => {
    const next = { ...categories };
    if (!modelId) delete next[category];
    else next[category] = modelId;
    setCategories(next);
    void persist({ mode: 'my_setup', categories: next });
  };

  const assignedCount = useMemo(
    () => ROUTE_CATEGORIES.filter((id) => categories[id]).length,
    [categories],
  );

  return (
    <div className="space-y-5">
      <div>
        <div className="lykn-settings-group overflow-hidden rounded-[14px] divide-y divide-black/[0.06] dark:divide-white/[0.08]">
          <button
            type="button"
            onClick={() => chooseMode('lykn')}
            className="flex w-full items-center justify-between gap-3 px-3.5 py-[13px] text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <span>
              <span className="block text-[13px] text-black dark:text-white">LYKN</span>
              <span className="mt-0.5 block text-[11px] text-black/45 dark:text-white/40">
                LYKN chooses the model for each turn.
              </span>
            </span>
            {mode === 'lykn' ? (
              <span className="text-[11px] text-black/40 dark:text-white/35">On</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => chooseMode('my_setup')}
            className="flex w-full items-center justify-between gap-3 px-3.5 py-[13px] text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <span>
              <span className="block text-[13px] text-black dark:text-white">My Setup</span>
              <span className="mt-0.5 block text-[11px] text-black/45 dark:text-white/40">
                You choose a model for each kind of work.
              </span>
            </span>
            {mode === 'my_setup' ? (
              <span className="text-[11px] text-black/40 dark:text-white/35">On</span>
            ) : null}
          </button>
        </div>
      </div>

      {mode === 'my_setup' ? (
        <>
        <div>
          <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.04em] text-black/40 dark:text-white/35">
            Routes
          </p>
          <div className="lykn-settings-group overflow-hidden rounded-[14px] divide-y divide-black/[0.06] dark:divide-white/[0.08]">
            {CATEGORIES.map((item) => {
              const assigned = categories[item.id] || null;
              const open = openCategory === item.id;
              return (
                <div key={item.id}>
                  <button
                    type="button"
                    onClick={() => setOpenCategory(open ? null : item.id)}
                    className="flex w-full items-center gap-3 px-3.5 py-[12px] text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] text-black dark:text-white">{item.label}</span>
                      <span className="mt-0.5 block text-[11px] text-black/45 dark:text-white/40">{item.hint}</span>
                    </span>
                    <span className={`inline-flex ${LG_INLINE_W} items-center justify-end gap-1 text-[12px] text-black/50 dark:text-white/45`}>
                      <span className="min-w-0 truncate">
                        {loadingCatalog && !assigned ? 'Loading…' : modelName(models, assigned)}
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 shrink-0 opacity-45 ${open ? 'rotate-180' : ''}`} />
                    </span>
                  </button>
                  {open ? (
                    <CatalogModelPicker
                      models={models}
                      value={assigned}
                      onSelect={(id) => chooseModel(item.id, id)}
                      onClose={() => setOpenCategory(null)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 px-3 text-[11px] leading-snug text-black/45 dark:text-white/40">
            {loadingCatalog
              ? 'Loading the OpenRouter catalog…'
              : status || `${models.length} models available. ${assignedCount} custom ${assignedCount === 1 ? 'route' : 'routes'} set.`}
          </p>
        </div>
        {children}
        </>
      ) : null}
    </div>
  );
}
