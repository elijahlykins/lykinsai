import { useState } from "react";
import { ChevronDown, ExternalLink, ShieldQuestion } from "lucide-react";

// Claude-style "connector detail" header. Renders the identity (icon +
// name + tagline), a longer description, a "Developed by" line, a trust
// note, the tool/capability list (with a count and "+N more" collapse),
// and a Details block (Author + Connector URL). Purely presentational —
// each connect dialog passes the right fields and keeps its own action
// area (connect button, token mint, install steps) below.

const DEFAULT_TRUST_NOTE =
  "Only connect apps from developers you trust. LYKN can't control what a third-party service does with the access you grant, or guarantee it behaves as intended. You can revoke access at any time.";

export function ConnectorDetailHeader({
  name,
  domain,
  iconNode: Icon,
  iconAccentClass,
  hideIcon = false,
  tagline,
  description,
  developer,
  tools,
  toolsLabel = "Tools",
  toolsNote,
  connectorUrl,
  author,
  trustNote = DEFAULT_TRUST_NOTE,
  initialToolsShown = 8,
}) {
  const [showAllTools, setShowAllTools] = useState(false);
  const toolList = Array.isArray(tools) ? tools.filter(Boolean) : [];
  const shownTools = showAllTools ? toolList : toolList.slice(0, initialToolsShown);
  const hiddenCount = toolList.length - shownTools.length;
  const resolvedAuthor = author || developer;
  const prettyUrl = connectorUrl ? connectorUrl.replace(/^https?:\/\//, "") : "";

  return (
    <div className="space-y-4">
      {/* ── Identity ─────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        {hideIcon ? null : Icon ? (
          <div
            className={`h-11 w-11 rounded-xl flex items-center justify-center flex-shrink-0 ring-1 ${
              iconAccentClass ||
              "bg-black/[0.04] dark:bg-white/[0.06] text-black/70 dark:text-white/80 ring-black/[0.06] dark:ring-white/[0.08]"
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </div>
        ) : (
          <div className="h-11 w-11 rounded-xl flex items-center justify-center flex-shrink-0 bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
            <DetailFavicon domain={domain} name={name} />
          </div>
        )}
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="text-[17px] font-semibold tracking-tight text-black/90 dark:text-white/95 truncate">
            {name}
          </h2>
          {tagline && (
            <p className="mt-0.5 text-[12px] leading-snug text-black/55 dark:text-white/55 line-clamp-2">
              {tagline}
            </p>
          )}
        </div>
      </div>

      {/* ── Description ──────────────────────────────────────── */}
      {(description || tagline) && (
        <p className="text-[12.5px] leading-relaxed text-black/70 dark:text-white/75">
          {description || tagline}
        </p>
      )}

      {developer && (
        <p className="text-[11.5px] text-black/50 dark:text-white/50">
          Developed by{" "}
          <span className="font-medium text-black/70 dark:text-white/75">{developer}</span>
        </p>
      )}

      {/* ── Trust note ───────────────────────────────────────── */}
      {trustNote && (
        <div className="flex items-start gap-2 rounded-lg border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2">
          <ShieldQuestion className="h-3.5 w-3.5 mt-[1px] flex-shrink-0 text-black/40 dark:text-white/40" />
          <p className="text-[10.5px] leading-relaxed text-black/50 dark:text-white/50">
            {trustNote}
          </p>
        </div>
      )}

      {/* ── Tools ────────────────────────────────────────────── */}
      {toolList.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-[12.5px] font-semibold text-black/85 dark:text-white/90">
              {toolsLabel}
            </h3>
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-[10px] font-semibold text-black/55 dark:text-white/60">
              {toolList.length}
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {shownTools.map((t) => (
              <li
                key={t}
                className="text-[12px] text-black/75 dark:text-white/80 flex items-start gap-2"
              >
                <span className="mt-[6px] h-1 w-1 rounded-full bg-black/35 dark:bg-white/35 flex-shrink-0" />
                {t}
              </li>
            ))}
          </ul>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllTools(true)}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-black/55 dark:text-white/55 hover:text-black/80 dark:hover:text-white/80 transition-colors"
            >
              <ChevronDown className="h-3 w-3" />+{hiddenCount} more
            </button>
          )}
          {toolsNote && (
            <p className="mt-2 text-[10.5px] leading-relaxed text-black/45 dark:text-white/45">
              {toolsNote}
            </p>
          )}
        </div>
      )}

      {/* ── Details ──────────────────────────────────────────── */}
      {(resolvedAuthor || connectorUrl) && (
        <div>
          <h3 className="text-[12.5px] font-semibold text-black/85 dark:text-white/90 mb-2">
            Details
          </h3>
          <dl className="space-y-1.5">
            {resolvedAuthor && (
              <div className="flex items-start gap-3 text-[11.5px]">
                <dt className="w-[88px] flex-shrink-0 text-black/45 dark:text-white/45">Author</dt>
                <dd className="min-w-0 flex-1 text-black/75 dark:text-white/80 truncate">
                  {resolvedAuthor}
                </dd>
              </div>
            )}
            {connectorUrl && (
              <div className="flex items-start gap-3 text-[11.5px]">
                <dt className="w-[88px] flex-shrink-0 text-black/45 dark:text-white/45">
                  Connector URL
                </dt>
                <dd className="min-w-0 flex-1">
                  <a
                    href={connectorUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 max-w-full text-black/70 dark:text-white/75 hover:text-black/90 dark:hover:text-white underline underline-offset-2 truncate"
                  >
                    <span className="truncate">{prettyUrl}</span>
                    <ExternalLink className="h-3 w-3 flex-shrink-0" />
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

function DetailFavicon({ domain, name }) {
  const [attempt, setAttempt] = useState(0);
  const candidates = [];
  if (domain) {
    candidates.push(`https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`);
    candidates.push(`https://icons.duckduckgo.com/ip3/${domain}.ico`);
  }
  if (!candidates.length || attempt >= candidates.length) {
    return (
      <span className="text-[15px] font-semibold text-black/65 dark:text-zinc-700">
        {name?.[0]?.toUpperCase() || "?"}
      </span>
    );
  }
  return (
    <img
      key={attempt}
      src={candidates[attempt]}
      alt={`${name} logo`}
      width={26}
      height={26}
      loading="lazy"
      decoding="async"
      onError={() => setAttempt((a) => a + 1)}
      className="block object-contain"
      style={{ width: 26, height: 26 }}
    />
  );
}
