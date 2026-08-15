import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import { WidgetFrame, WidgetHeader } from './shared';

/**
 * A second time zone, next to the Clock. Everything is computed with Intl, so
 * daylight saving and the "it's already tomorrow there" case come out right
 * without a timezone table of our own.
 */

const FALLBACK_ZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function allZones() {
  try {
    const list = Intl.supportedValuesOf?.('timeZone');
    if (Array.isArray(list) && list.length) return list;
  } catch {
    /* older engines — the shortlist is plenty */
  }
  return FALLBACK_ZONES;
}

/** "Asia/Tokyo" → "Tokyo". The region is noise once it's on the desktop. */
export function zoneLabel(tz) {
  return String(tz || '')
    .split('/')
    .pop()
    .replace(/_/g, ' ');
}

function partsIn(date, tz) {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    const out = {};
    for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
    return {
      time: `${out.hour}:${out.minute}${out.dayPeriod ? ` ${out.dayPeriod}` : ''}`,
      day: `${out.weekday}, ${out.month} ${out.day}`,
    };
  } catch {
    return { time: '—', day: '' };
  }
}

/** Whole days between here and there, so the widget can say "Tomorrow". */
function dayOffset(date, tz) {
  const there = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  const here = new Date(date.toLocaleString('en-US'));
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(there) - startOf(here)) / 86_400_000);
}

function ZonePicker({ onPick, onCancel }) {
  const [query, setQuery] = useState('');
  const zones = useMemo(allZones, []);
  const needle = query.trim().toLowerCase();
  const matches = (needle
    ? zones.filter((z) => z.toLowerCase().replace(/_/g, ' ').includes(needle))
    : FALLBACK_ZONES
  ).slice(0, 40);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-black/[0.06] px-2 py-1 dark:bg-white/[0.08]">
        <Search className="h-3 w-3 flex-shrink-0 text-black/40 dark:text-white/40" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
            if (e.key === 'Enter' && matches[0]) onPick(matches[0]);
          }}
          placeholder="City or zone…"
          className="w-full bg-transparent text-[0.7rem] text-black/85 outline-none placeholder:text-black/35 dark:text-white/90 dark:placeholder:text-white/30"
        />
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto scrollbar-hide">
        {matches.map((z) => (
          <button
            key={z}
            type="button"
            onClick={() => onPick(z)}
            className="block w-full truncate rounded-md px-1 py-0.5 text-left text-[0.66rem] text-black/80 hover:bg-black/[0.05] dark:text-white/85 dark:hover:bg-white/[0.08]"
          >
            {zoneLabel(z)}
            <span className="text-black/35 dark:text-white/35"> · {z.split('/')[0]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function WorldClockWidget({ size = 'small', props = {}, onChangeProps }) {
  const tz = String(props.tz || '');
  const [picking, setPicking] = useState(!tz);
  const [now, setNow] = useState(() => new Date());

  // Tick on the minute boundary, not every second — the desktop shouldn't
  // re-render sixty times a minute for a clock that shows minutes.
  useEffect(() => {
    let timer;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()));
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);

  if (picking || !tz) {
    return (
      <WidgetFrame className="flex flex-col p-3">
        <WidgetHeader label="World Clock" tone="text-indigo-500" />
        <div className="mt-1.5 min-h-0 flex-1">
          <ZonePicker
            onPick={(zone) => {
              setPicking(false);
              onChangeProps?.({ tz: zone });
            }}
            onCancel={() => setPicking(!tz)}
          />
        </div>
      </WidgetFrame>
    );
  }

  const { time, day } = partsIn(now, tz);
  const offset = dayOffset(now, tz);
  const offsetLabel = offset === 0 ? '' : offset > 0 ? 'Tomorrow' : 'Yesterday';

  return (
    <WidgetFrame
      as="button"
      type="button"
      onClick={() => setPicking(true)}
      title="Change time zone"
      className={`flex flex-col justify-center p-3.5 text-left transition-transform active:scale-[0.98] ${
        size === 'medium' ? 'gap-0.5' : ''
      }`}
    >
      <p className="truncate text-[0.62rem] font-bold uppercase tracking-[0.08em] text-indigo-500">
        {zoneLabel(tz)}
      </p>
      <p
        className={`font-semibold leading-none tracking-tight tabular-nums text-black/90 dark:text-white/95 ${
          size === 'small' ? 'mt-2 text-[1.75rem]' : 'mt-1.5 text-[2.4rem]'
        }`}
      >
        {time}
      </p>
      <p className="mt-2 truncate text-[0.7rem] text-black/45 dark:text-white/45">
        {offsetLabel ? `${offsetLabel} · ${day}` : day}
      </p>
    </WidgetFrame>
  );
}
