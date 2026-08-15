import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ListTodo, Lock } from 'lucide-react';

import { supabase } from '@/lib/supabase';

import { WidgetFrame, WidgetHeader } from './shared';

/**
 * Three numbers: what's open, what's coming, what's saved. Counts come back as
 * exact head-only queries, so this stays cheap no matter how full the account
 * is — nothing is fetched but the totals.
 */
function useGlanceCounts(userId) {
  return useQuery({
    queryKey: ['studio-glance', userId || 'guest'],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + 7 * 86_400_000);

      const count = async (build) => {
        try {
          const { count: n, error } = await build();
          return error ? 0 : n || 0;
        } catch {
          return 0;
        }
      };

      const [todos, events, vault] = await Promise.all([
        count(() =>
          supabase
            .from('lykn_todos')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'open'),
        ),
        count(() =>
          supabase
            .from('lykn_events')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .neq('status', 'cancelled')
            .gte('starts_at', from.toISOString())
            .lte('starts_at', to.toISOString()),
        ),
        count(() =>
          supabase
            .from('vault_items')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
        ),
      ]);

      return { todos, events, vault };
    },
  });
}

export default function GlanceWidget({ userId, size = 'small', onOpen }) {
  const { data } = useGlanceCounts(userId);
  const rows = [
    {
      id: 'todos',
      icon: ListTodo,
      tone: 'text-orange-500',
      value: data?.todos ?? 0,
      label: 'open to-do',
      plural: 'open to-dos',
      go: () => onOpen?.('todos', '/todos'),
    },
    {
      id: 'events',
      icon: CalendarDays,
      tone: 'text-red-500',
      value: data?.events ?? 0,
      label: 'event this week',
      plural: 'events this week',
      go: () => onOpen?.('calendar', '/calendar'),
    },
    {
      id: 'vault',
      icon: Lock,
      tone: 'text-emerald-500',
      value: data?.vault ?? 0,
      label: 'item in the Vault',
      plural: 'items in the Vault',
      go: () => onOpen?.('vault'),
    },
  ];

  const columns = size === 'medium';

  return (
    <WidgetFrame className="flex flex-col p-3.5">
      <WidgetHeader label="At a glance" tone="text-black/45 dark:text-white/45" />
      <div
        className={`mt-1.5 min-h-0 flex-1 ${
          columns ? 'grid grid-cols-3 items-center gap-2' : 'flex flex-col justify-around'
        }`}
      >
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={row.go}
            title={`${row.value} ${row.value === 1 ? row.label : row.plural}`}
            className={`rounded-lg text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
              columns ? 'flex flex-col items-center gap-0.5 p-1' : 'flex items-center gap-2 px-1 py-1'
            }`}
          >
            <row.icon className={`h-4 w-4 flex-shrink-0 ${row.tone}`} strokeWidth={1.9} />
            <span className={columns ? 'flex flex-col items-center' : 'flex min-w-0 items-baseline gap-1.5'}>
              <span className="text-[1.05rem] font-semibold leading-none tabular-nums text-black/90 dark:text-white/95">
                {row.value}
              </span>
              <span
                className={`text-[0.6rem] leading-tight text-black/45 dark:text-white/45 ${
                  columns ? 'mt-1 text-center' : 'truncate'
                }`}
              >
                {columns
                  ? row.id === 'events'
                    ? 'this week'
                    : row.id === 'todos'
                      ? 'to-dos'
                      : 'in Vault'
                  : row.value === 1
                    ? row.label
                    : row.plural}
              </span>
            </span>
          </button>
        ))}
      </div>
    </WidgetFrame>
  );
}
