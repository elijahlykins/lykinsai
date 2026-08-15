import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api-config";
import { fetchTodayDocket, type TodayDocket } from "@/lib/synthesis/loadInUpdates";
import { buildDocketPrompt, streamDocketBriefing } from "@/lib/synthesis/docketBriefing";

// The day's brief, in one place: what Night Shift left overnight, what's on
// the plate today, and a short AI rundown of it. Loading is split in two so a
// caller can put the cheap half behind a preview and only pay for the model
// when the user actually opens the brief.

export interface NightBrief {
  id: string;
  projectId: string | null;
  projectName: string;
  value: string;
  setAt: number;
  setByClient: string | null;
}

export interface DailyBrief {
  /** null until the fetch lands (or while inactive). */
  docket: TodayDocket | null;
  nightBriefs: NightBrief[];
  loaded: boolean;
  /** Accumulated rundown text, typed out as it streams. */
  briefing: string;
  briefingDone: boolean;
  /** Whether there's anything at all to show. */
  hasContent: boolean;
}

async function fetchNightBriefs(): Promise<NightBrief[]> {
  // The endpoint only returns briefs from the last night, and Authorization is
  // injected globally by installAuthFetch.
  try {
    const res = await fetch(`${API_BASE_URL}/api/night-shift/briefs`);
    if (!res.ok) return [];
    const json = await res.json();
    const rows = Array.isArray(json?.briefs) ? json.briefs : [];
    return rows
      .map((row: Record<string, unknown>) => ({
        id: String(row.id || ""),
        projectId: row.projectId ? String(row.projectId) : null,
        projectName: String(row.projectName || "Project"),
        value: String(row.value || ""),
        setAt: Date.parse(String(row.setAt || "")) || 0,
        setByClient: row.setByClient ? String(row.setByClient) : null,
      }))
      .filter((b: NightBrief) => !!b.value);
  } catch {
    return [];
  }
}

/**
 * @param active Load the docket and any overnight briefs.
 * @param stream Also stream the AI rundown of the docket (costs a model call).
 */
export function useDailyBrief({
  active,
  stream,
  greetingName,
}: {
  active: boolean;
  stream: boolean;
  greetingName?: string | null;
}): DailyBrief {
  const [docket, setDocket] = useState<TodayDocket | null>(null);
  const [nightBriefs, setNightBriefs] = useState<NightBrief[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [briefing, setBriefing] = useState("");
  const [briefingDone, setBriefingDone] = useState(false);

  // Read at stream time rather than depended on, so a name arriving late (or a
  // parent re-render) can't restart a rundown that's already typing out.
  const nameRef = useRef(greetingName);
  nameRef.current = greetingName;

  // Going inactive clears everything, so reopening re-fetches instead of
  // flashing yesterday's brief while the new one loads.
  useEffect(() => {
    if (!active) {
      setDocket(null);
      setNightBriefs([]);
      setLoaded(false);
      setBriefing("");
      setBriefingDone(false);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const [nextDocket, briefs] = await Promise.all([fetchTodayDocket(), fetchNightBriefs()]);
      if (cancelled) return;
      setDocket(nextDocket);
      setNightBriefs(briefs);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    if (!stream || !docket) return undefined;
    const prompt = buildDocketPrompt(docket, nameRef.current);
    // Nothing on the plate — there's nothing for the model to brief on.
    if (!prompt) return undefined;
    const controller = new AbortController();
    setBriefing("");
    setBriefingDone(false);
    void (async () => {
      try {
        await streamDocketBriefing(
          prompt,
          (text) => {
            if (!controller.signal.aborted) setBriefing(text);
          },
          controller.signal,
        );
      } catch {
        // Silent — the items still stand on their own without a rundown.
      } finally {
        if (!controller.signal.aborted) setBriefingDone(true);
      }
    })();
    return () => controller.abort();
  }, [stream, docket]);

  const hasContent = useMemo(() => {
    if (nightBriefs.length > 0) return true;
    if (!docket) return false;
    return docket.events.length > 0 || docket.dueToday.length > 0 || docket.overdue.length > 0;
  }, [docket, nightBriefs]);

  return { docket, nightBriefs, loaded, briefing, briefingDone, hasContent };
}
