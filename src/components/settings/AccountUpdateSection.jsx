import { useProductUpdate } from "@/hooks/useProductUpdate";
import { useDesktopUpdate } from "@/hooks/useDesktopUpdate";

export default function AccountUpdateSection() {
  const product = useProductUpdate();
  const desktop = useDesktopUpdate();

  return (
    <div className="space-y-5">
      {desktop.desktop ? (
        <div>
          <div className="lykn-settings-group overflow-hidden rounded-[14px] divide-y divide-black/[0.06] dark:divide-white/[0.08]">
            <div className="flex w-full items-center gap-3 px-3.5 py-[11px] text-left">
              <div className="min-w-0 flex-1 py-0.5">
                <p className="text-[13px] leading-snug text-black dark:text-white">Desktop version</p>
                <p className="mt-0.5 text-[11px] leading-snug text-black/45 dark:text-white/40">
                  {desktop.currentVersion
                    ? `LYKN ${desktop.currentVersion}`
                    : "LYKN desktop"}
                </p>
              </div>
              {desktop.ready ? (
                <button
                  type="button"
                  onClick={() => void desktop.install()}
                  className="shrink-0 rounded-md px-2.5 py-1 text-[13px] font-medium text-[#007aff]"
                >
                  Restart to update{desktop.pendingVersion ? ` ${desktop.pendingVersion}` : ""}
                </button>
              ) : desktop.downloading ? (
                <span className="shrink-0 text-[13px] text-black/45 dark:text-white/45">Downloading…</span>
              ) : (
                <span className="shrink-0 text-[13px] text-black/45 dark:text-white/45">Up to date</span>
              )}
            </div>
          </div>
          <p className="mt-1.5 px-3 text-[11px] leading-snug text-black/45 dark:text-white/40">
            Updates download in the background. Restart when you are ready.
          </p>
        </div>
      ) : null}

      {product.visible ? (
        <div>
          <div className="lykn-settings-group overflow-hidden rounded-[14px] divide-y divide-black/[0.06] dark:divide-white/[0.08]">
            <div className="px-3.5 py-3">
              <p className="text-[13px] font-medium leading-snug text-black dark:text-white">
                {product.update.title}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-black/55 dark:text-white/55">
                {product.update.summary}
              </p>
              <ul className="mt-2 space-y-1.5">
                {product.update.highlights.map((line) => (
                  <li
                    key={line}
                    className="text-[12px] leading-relaxed text-black/65 dark:text-white/65"
                  >
                    {line}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void product.dismiss()}
                className="mt-3 text-[13px] font-medium text-[#007aff]"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
