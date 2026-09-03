import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  MapPin,
  Moon,
  Search,
  Sun,
} from 'lucide-react';

import { WidgetFrame, WidgetHeader } from './shared';

/**
 * Current conditions for a place the user picks, from Open-Meteo — a free,
 * key-less forecast service, so this needs no account and no server of ours in
 * the middle. The place is stored on the widget, which means two Weather
 * widgets can watch two cities.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/* WMO weather codes, collapsed to the handful of conditions worth drawing. */
const CONDITIONS = [
  { codes: [0], label: 'Clear', day: Sun, night: Moon },
  { codes: [1, 2], label: 'Partly cloudy', day: CloudSun, night: CloudSun },
  { codes: [3], label: 'Overcast', day: Cloud, night: Cloud },
  { codes: [45, 48], label: 'Fog', day: CloudFog, night: CloudFog },
  { codes: [51, 53, 55, 56, 57], label: 'Drizzle', day: CloudDrizzle, night: CloudDrizzle },
  { codes: [61, 63, 65, 66, 67, 80, 81, 82], label: 'Rain', day: CloudRain, night: CloudRain },
  { codes: [71, 73, 75, 77, 85, 86], label: 'Snow', day: CloudSnow, night: CloudSnow },
  { codes: [95, 96, 99], label: 'Thunderstorms', day: CloudLightning, night: CloudLightning },
];

function conditionFor(code, isDay) {
  const match = CONDITIONS.find((c) => c.codes.includes(Number(code)));
  if (!match) return { label: 'Weather', Icon: isDay ? Sun : Moon };
  return { label: match.label, Icon: isDay ? match.day : match.night };
}

/** Fahrenheit for US locales, Celsius everywhere else — same call the OS makes. */
function preferredUnit() {
  try {
    const locale = navigator.language || 'en-US';
    return /^en-(US|LR|MM)\b/i.test(locale) ? 'fahrenheit' : 'celsius';
  } catch {
    return 'celsius';
  }
}

const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);

function useForecast(place, unit) {
  return useQuery({
    queryKey: ['home-weather', place?.lat, place?.lon, unit],
    enabled: !!place,
    staleTime: 15 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: 1,
    queryFn: async () => {
      const params = new URLSearchParams({
        latitude: String(place.lat),
        longitude: String(place.lon),
        current: 'temperature_2m,weather_code,is_day,apparent_temperature',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min',
        timezone: 'auto',
        forecast_days: '5',
        temperature_unit: unit,
      });
      const res = await fetch(`${FORECAST_URL}?${params}`);
      if (!res.ok) throw new Error('forecast_failed');
      return res.json();
    },
  });
}

/** Type a city, pick it from the list — Open-Meteo's geocoder, same service. */
function PlacePicker({ onPick, onCancel }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      return undefined;
    }
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `${GEOCODE_URL}?name=${encodeURIComponent(needle)}&count=5&language=en&format=json`,
        );
        const json = res.ok ? await res.json() : {};
        if (seq.current === mine) setResults(json.results || []);
      } catch {
        if (seq.current === mine) setResults([]);
      } finally {
        if (seq.current === mine) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

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
            if (e.key === 'Enter' && results[0]) onPick(results[0]);
          }}
          placeholder="City…"
          className="w-full bg-transparent text-[0.7rem] text-black/85 outline-none placeholder:text-black/35 dark:text-white/90 dark:placeholder:text-white/30"
        />
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto scrollbar-hide">
        {results.map((r) => (
          <button
            key={`${r.id}`}
            type="button"
            onClick={() => onPick(r)}
            className="block w-full truncate rounded-md px-1 py-0.5 text-left text-[0.66rem] text-black/80 hover:bg-black/[0.05] dark:text-white/85 dark:hover:bg-white/[0.08]"
          >
            {r.name}
            <span className="text-black/40 dark:text-white/40">
              {r.admin1 ? `, ${r.admin1}` : ''} {r.country_code || ''}
            </span>
          </button>
        ))}
        {!results.length && (
          <p className="px-1 pt-1 text-[0.62rem] leading-snug text-black/40 dark:text-white/40">
            {busy ? 'Searching…' : 'Type a city to find it.'}
          </p>
        )}
      </div>
    </div>
  );
}

export default function WeatherWidget({ size = 'small', props = {}, onChangeProps }) {
  const place = props.place && Number.isFinite(props.place.lat) ? props.place : null;
  const [picking, setPicking] = useState(false);
  const unit = useMemo(preferredUnit, []);
  const { data, isError, isLoading } = useForecast(place, unit);

  // No place yet: ask the OS once. If it says no (or takes too long), the
  // widget just shows its "Set location" state instead of nagging.
  useEffect(() => {
    if (place || picking || !navigator.geolocation) return;
    let done = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (done) return;
        done = true;
        onChangeProps?.({
          place: {
            name: 'My location',
            lat: Number(pos.coords.latitude.toFixed(3)),
            lon: Number(pos.coords.longitude.toFixed(3)),
          },
        });
      },
      () => {},
      { timeout: 8000, maximumAge: 30 * 60_000 },
    );
    return () => {
      done = true;
    };
  }, [place, picking, onChangeProps]);

  const pick = (r) => {
    setPicking(false);
    onChangeProps?.({
      place: {
        name: r.name,
        lat: Number(Number(r.latitude).toFixed(3)),
        lon: Number(Number(r.longitude).toFixed(3)),
      },
    });
  };

  if (picking || !place) {
    return (
      <WidgetFrame className="flex flex-col p-3">
        <WidgetHeader label="Weather" tone="text-sky-500" />
        <div className="mt-1.5 min-h-0 flex-1">
          {picking ? (
            <PlacePicker onPick={pick} onCancel={() => setPicking(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-black/40 dark:text-white/40"
            >
              <MapPin className="h-5 w-5" />
              <span className="text-[0.68rem]">Set location</span>
            </button>
          )}
        </div>
      </WidgetFrame>
    );
  }

  const current = data?.current || {};
  const daily = data?.daily || {};
  const { label, Icon } = conditionFor(current.weather_code, current.is_day !== 0);
  const temp = round(current.temperature_2m);
  const hi = round(daily.temperature_2m_max?.[0]);
  const lo = round(daily.temperature_2m_min?.[0]);
  const deg = '°';

  const days = (daily.time || []).slice(1, size === 'large' ? 5 : 0).map((iso, i) => ({
    iso,
    label: new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }),
    Icon: conditionFor(daily.weather_code?.[i + 1], true).Icon,
    hi: round(daily.temperature_2m_max?.[i + 1]),
    lo: round(daily.temperature_2m_min?.[i + 1]),
  }));

  return (
    <WidgetFrame className="flex flex-col p-3.5">
      <WidgetHeader
        label={place.name}
        tone="text-sky-500"
        onClick={() => setPicking(true)}
        action={
          <Icon className="h-4 w-4 flex-shrink-0 text-black/60 dark:text-white/70" strokeWidth={1.8} />
        }
      />
      {isError ? (
        <div className="flex min-h-0 flex-1 items-center">
          <p className="text-[0.66rem] leading-snug text-black/40 dark:text-white/40">
            Couldn&rsquo;t reach the forecast.
          </p>
        </div>
      ) : (
        <>
          <div className={size === 'small' ? 'mt-1' : 'mt-1.5 flex items-baseline gap-2'}>
            <p className="text-[1.9rem] font-semibold leading-none tracking-tight tabular-nums text-black/90 dark:text-white/95">
              {temp === null ? (isLoading ? '-' : '-') : `${temp}${deg}`}
            </p>
            {size !== 'small' && (
              <p className="truncate text-[0.72rem] text-black/55 dark:text-white/55">{label}</p>
            )}
          </div>
          {size === 'small' && (
            <p className="mt-1 truncate text-[0.66rem] text-black/55 dark:text-white/55">{label}</p>
          )}
          <p className="mt-0.5 text-[0.66rem] tabular-nums text-black/40 dark:text-white/40">
            {hi === null ? '' : `H:${hi}${deg}  L:${lo}${deg}`}
          </p>
          {days.length > 0 && (
            <div className="mt-auto grid grid-cols-4 gap-1 pt-2">
              {days.map((d) => (
                <div key={d.iso} className="flex flex-col items-center gap-1">
                  <span className="text-[0.6rem] font-medium text-black/45 dark:text-white/45">
                    {d.label}
                  </span>
                  <d.Icon className="h-4 w-4 text-black/55 dark:text-white/60" strokeWidth={1.8} />
                  <span className="text-[0.6rem] tabular-nums text-black/70 dark:text-white/75">
                    {d.hi}
                    {deg}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </WidgetFrame>
  );
}
