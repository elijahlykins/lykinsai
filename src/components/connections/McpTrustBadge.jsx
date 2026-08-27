const LABELS = {
  official: { text: "Official", mark: true },
  verified: { text: "Verified", mark: true },
  enterprise: { text: "Enterprise", mark: true },
  community: { text: "Community", mark: false },
  custom: { text: "Custom MCP", mark: false },
  remote: { text: "Custom MCP", mark: false },
  local_trusted: { text: "Local MCP", mark: false },
};

export default function McpTrustBadge({ trust, compact = false }) {
  const spec = LABELS[trust] || LABELS.custom;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        spec.mark
          ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
          : "bg-black/[0.05] text-black/50 dark:bg-white/[0.08] dark:text-white/50"
      }`}
      title={
        trust === "community"
          ? "LYKN has not audited this community server."
          : trust === "custom" || trust === "remote"
            ? "You added this URL. TLS does not make it Official."
            : trust === "local_trusted"
              ? "This runs a program on this computer."
              : spec.text
      }
    >
      {spec.mark ? "✓ " : ""}
      {compact ? spec.text : spec.text}
    </span>
  );
}
