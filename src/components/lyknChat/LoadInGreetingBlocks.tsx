import React, { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, Check, ChevronRight, Plus, RefreshCw, Trash2, X as XIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { safeNavHref } from "@/lib/safeExternalUrl";
import { handleLyknBrowserClick, studioOpenChatOpts } from "@/lib/lyknChat/openInStudioBrowser";

/**
 * Notification-style bubble for one connector source inside a
 * load-in greeting section. Collapsed: a row showing the app's
 * branded logo + label + count + preview of the latest item.
 * Expanded: a dropdown list of items, each linking out to its
 * canonical source URL (the actual Gmail email, Notion page, etc.).
 * Each bubble owns its own open/closed state — sections may stack
 * several bubbles and the user opens whichever they care about.
 */
export const LoadInBubble: React.FC<{
  msgId: string;
  chatId?: string | null;
  group: {
    id: string;
    label: string;
    iconUrl?: string;
    domain?: string;
    count: number;
    latestTitle?: string;
    latestRelative?: string;
    items: Array<{ id: string; title: string; subtitle?: string; href?: string }>;
  };
}> = ({ msgId, chatId, group }) => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const iconCandidate =
    group.iconUrl ||
    (group.domain
      ? `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(group.domain)}`
      : null);
  return (
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/50 dark:bg-white/[0.04] backdrop-blur-md shadow-none overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/40 dark:hover:bg-white/[0.06] transition-colors"
      >
        {iconCandidate ? (
          <img
            src={iconCandidate}
            alt=""
            className="w-7 h-7 rounded-md object-contain flex-shrink-0 bg-white/60 dark:bg-white/10 p-0.5"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="w-7 h-7 rounded-md bg-white/60 dark:bg-white/10 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0 leading-tight">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-black/85 dark:text-white/90 truncate">
              {group.label}
            </span>
            <span className="text-[11px] opacity-60 flex-shrink-0">
              {group.count} new
            </span>
          </div>
          <div className="text-[12px] opacity-75 truncate mt-0.5">
            {group.latestTitle
              ? `${group.latestTitle}${group.latestRelative ? ` · ${group.latestRelative}` : ""}`
              : group.latestRelative || ""}
          </div>
        </div>
        <ChevronRight
          className={`w-4 h-4 text-black/40 dark:text-white/40 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="px-2 pb-2 pt-1 space-y-1 border-t border-white/30 dark:border-white/5">
            {group.items.map((it) => {
              const navHref = typeof it.href === "string" ? safeNavHref(it.href) : null;
              const hasHref = !!navHref;
              const isInternal = navHref?.kind === "internal";
              // Optional grounding chips ("Grounded in: <Notion page>,
              // <Calendar event>, ...") rendered under the item's
              // subtitle. Older cached briefings won't carry the
              // `provenance` array, so we only render the row when at
              // least one chip is present.
              const provenance = Array.isArray((it as { provenance?: unknown }).provenance)
                ? (it as { provenance?: Array<{ id: string; label: string; href?: string; connectorId?: string }> }).provenance!
                : [];
              const inner = (
                <div className="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-white/50 dark:hover:bg-white/[0.06] transition-colors">
                  <div className="flex-1 min-w-0 leading-tight">
                    <div className="text-[12.5px] text-black/85 dark:text-white/90 truncate">
                      {it.title}
                    </div>
                    {it.subtitle ? (
                      <div className="text-[11px] opacity-60 mt-0.5 truncate">
                        {it.subtitle}
                      </div>
                    ) : null}
                    {provenance.length > 0 ? (
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        <span className="text-[10.5px] uppercase tracking-wider opacity-50">
                          Grounded in
                        </span>
                        {provenance.slice(0, 3).map((chip) => {
                          const chipNav = typeof chip.href === "string" ? safeNavHref(chip.href) : null;
                          const chipInternal = chipNav?.kind === "internal";
                          const onChipClick = (e: React.MouseEvent) => {
                            // Stop the parent row's anchor click from
                            // double-navigating when the chip lives
                            // inside an outer <a>.
                            e.stopPropagation();
                            if (!chipNav) return;
                            if (e.metaKey || e.ctrlKey || e.shiftKey || (e as unknown as { button?: number }).button === 1) return;
                            if (chipInternal) {
                              e.preventDefault();
                              navigate(chipNav.href);
                              return;
                            }
                            handleLyknBrowserClick(e, chipNav.href, chip.label, studioOpenChatOpts(chatId));
                          };
                          const chipFace = (
                            <span className="inline-flex max-w-[180px] items-center rounded-full border border-black/[0.08] dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04] px-1.5 py-[1px] text-[10.5px] font-medium text-black/70 dark:text-white/70 truncate">
                              {chip.label}
                            </span>
                          );
                          if (!chipNav) {
                            return (
                              <span key={chip.id}>{chipFace}</span>
                            );
                          }
                          return (
                            <a
                              key={chip.id}
                              href={chipNav.href}
                              onClick={onChipClick}
                              target={chipInternal ? undefined : "_blank"}
                              rel={chipInternal ? undefined : "noopener noreferrer"}
                              className="inline-flex max-w-[180px] hover:opacity-90"
                              title={chip.label}
                            >
                              {chipFace}
                            </a>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  {hasHref ? (
                    <ArrowRight className="w-3.5 h-3.5 opacity-40 mt-1 flex-shrink-0" />
                  ) : null}
                </div>
              );
              if (!navHref) {
                return <div key={`${msgId}-${group.id}-${it.id}`}>{inner}</div>;
              }
              // Internal hrefs route via react-router so we don't
              // hard-reload the app and lose chat state; external
              // hrefs (Gmail / Notion / Slack URLs etc.) open in the
              // LYKN in-app browser.
              const onClick = (e: React.MouseEvent) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || (e as any).button === 1) return;
                if (isInternal) {
                  e.preventDefault();
                  navigate(navHref.href);
                  return;
                }
                handleLyknBrowserClick(e, navHref.href, studioOpenChatOpts(chatId));
              };
              return (
                <a
                  key={`${msgId}-${group.id}-${it.id}`}
                  href={navHref.href}
                  onClick={onClick}
                  target={isInternal ? undefined : "_blank"}
                  rel={isInternal ? undefined : "noopener noreferrer"}
                  className="block"
                >
                  {inner}
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Inline editor / composer that lets the user add personal sections to
 * the bottom of their daily load-in briefing. Talks to
 * `lykn_load_in_user_sections` directly (RLS-scoped to the current
 * user) and asks the parent to refresh the greeting payload after
 * every CRUD so the rest of the bubble stays in sync.
 *
 * Three modes:
 *   • idle    — shows a dashed "+ Add a section" tile.
 *   • create  — heading + body inputs with Save / Cancel.
 *   • saving  — spinner-y disabled state while supabase round-trips.
 *
 * Edit and delete affordances for already-saved user sections are
 * rendered inline next to each section heading by `MessageItem`; this
 * component is only responsible for *new* sections plus the
 * "edit current section X" form when the parent passes editingId.
 */
export const LoadInUserSectionsComposer: React.FC<{
  onChanged?: () => void | Promise<void>;
}> = ({ onChanged }) => {
  const [mode, setMode] = useState<"idle" | "create">("idle");
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setHeading("");
    setBody("");
    setError(null);
    setMode("idle");
  };

  const save = useCallback(async () => {
    const h = heading.trim();
    if (!h) {
      setError("Add a heading so I know what to call this section.");
      return;
    }
    if (h.length > 120) {
      setError("Heading is too long. Keep it under 120 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const userId = session?.session?.user?.id;
      if (!userId) {
        setError("You need to be signed in to add a section.");
        setSaving(false);
        return;
      }
      const { error: insertErr } = await supabase
        .from("lykn_load_in_user_sections")
        .insert({
          user_id: userId,
          heading: h,
          body: body.trim(),
        });
      if (insertErr) {
        setError(insertErr.message || "Couldn't save. Try again?");
        setSaving(false);
        return;
      }
      reset();
      if (onChanged) await onChanged();
    } catch (e: any) {
      setError(String(e?.message || e || "Save failed."));
    } finally {
      setSaving(false);
    }
  }, [heading, body, onChanged]);

  if (mode === "idle") {
    return (
      <button
        type="button"
        onClick={() => setMode("create")}
        className="group/addsec w-full flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-black/15 dark:border-white/15 bg-white/30 dark:bg-white/[0.025] hover:bg-white/55 dark:hover:bg-white/[0.05] hover:border-black/30 dark:hover:border-white/30 px-4 py-3 text-[12.5px] font-medium text-black/60 dark:text-white/60 hover:text-black/85 dark:hover:text-white/85 transition-all"
      >
        <Plus className="w-3.5 h-3.5 opacity-70 group-hover/addsec:opacity-100 transition-opacity" />
        <span>Add a section</span>
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/55 dark:bg-white/[0.04] backdrop-blur-md shadow-none overflow-hidden">
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-black/55 dark:text-white/55">
          New section
        </div>
        <button
          type="button"
          onClick={reset}
          disabled={saving}
          className="p-1 rounded-md text-black/45 dark:text-white/45 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          aria-label="Cancel"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-3 pb-3 space-y-2">
        <input
          type="text"
          value={heading}
          onChange={(e) => setHeading(e.target.value)}
          placeholder="Heading (e.g. Today's focus)"
          maxLength={120}
          disabled={saving}
          className="w-full bg-white/70 dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-[13px] font-semibold text-black/85 dark:text-white/90 placeholder:font-normal placeholder:text-black/35 dark:placeholder:text-white/30 focus:outline-none focus:border-black/25 dark:focus:border-white/25 transition-colors"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add notes, links, bullets. Markdown works."
          rows={4}
          maxLength={4000}
          disabled={saving}
          className="w-full bg-white/70 dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed text-black/80 dark:text-white/85 placeholder:text-black/35 dark:placeholder:text-white/30 focus:outline-none focus:border-black/25 dark:focus:border-white/25 transition-colors resize-y"
        />
        {error ? (
          <div className="text-[11.5px] text-rose-600 dark:text-rose-300">{error}</div>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={reset}
            disabled={saving}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium text-black/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !heading.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-blue-400/40 bg-blue-500/15 hover:bg-blue-500/25 text-blue-700 dark:text-blue-200 text-[12px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Check className="w-3 h-3" />
            )}
            <span>{saving ? "Saving…" : "Save section"}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Editable view of a single user-authored section. Renders inline in
 * place of the static heading + body when the user clicks "edit" on a
 * section they own. Supports rename, body rewrite, and delete.
 */
export const LoadInUserSectionEditor: React.FC<{
  sectionId: string;
  initialHeading: string;
  initialBody: string;
  onDone: () => void;
  onChanged?: () => void | Promise<void>;
}> = ({ sectionId, initialHeading, initialBody, onDone, onChanged }) => {
  const [heading, setHeading] = useState(initialHeading);
  const [body, setBody] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    const h = heading.trim();
    if (!h) {
      setError("Heading can't be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("lykn_load_in_user_sections")
        .update({ heading: h, body: body.trim() })
        .eq("id", sectionId);
      if (updErr) {
        setError(updErr.message || "Couldn't save changes.");
        setSaving(false);
        return;
      }
      if (onChanged) await onChanged();
      onDone();
    } catch (e: any) {
      setError(String(e?.message || e || "Save failed."));
    } finally {
      setSaving(false);
    }
  }, [heading, body, sectionId, onChanged, onDone]);

  const remove = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const { error: delErr } = await supabase
        .from("lykn_load_in_user_sections")
        .delete()
        .eq("id", sectionId);
      if (delErr) {
        setError(delErr.message || "Couldn't delete.");
        setDeleting(false);
        return;
      }
      if (onChanged) await onChanged();
      onDone();
    } catch (e: any) {
      setError(String(e?.message || e || "Delete failed."));
      setDeleting(false);
    }
  }, [sectionId, onChanged, onDone]);

  const busy = saving || deleting;

  return (
    <div className="rounded-2xl border border-white/40 dark:border-white/10 bg-white/55 dark:bg-white/[0.04] backdrop-blur-md shadow-none overflow-hidden">
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-black/55 dark:text-white/55">
          Editing section
        </div>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-rose-600 dark:text-rose-300 hover:bg-rose-500/10 transition-colors disabled:opacity-40"
          aria-label="Delete section"
        >
          <Trash2 className="w-3 h-3" />
          <span>{deleting ? "Deleting…" : "Delete"}</span>
        </button>
      </div>
      <div className="px-3 pb-3 space-y-2">
        <input
          type="text"
          value={heading}
          onChange={(e) => setHeading(e.target.value)}
          maxLength={120}
          disabled={busy}
          className="w-full bg-white/70 dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-[13px] font-semibold text-black/85 dark:text-white/90 focus:outline-none focus:border-black/25 dark:focus:border-white/25 transition-colors"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={4000}
          disabled={busy}
          className="w-full bg-white/70 dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed text-black/80 dark:text-white/85 focus:outline-none focus:border-black/25 dark:focus:border-white/25 transition-colors resize-y"
        />
        {error ? (
          <div className="text-[11.5px] text-rose-600 dark:text-rose-300">{error}</div>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onDone}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium text-black/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !heading.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-blue-400/40 bg-blue-500/15 hover:bg-blue-500/25 text-blue-700 dark:text-blue-200 text-[12px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Check className="w-3 h-3" />
            )}
            <span>{saving ? "Saving…" : "Save"}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
