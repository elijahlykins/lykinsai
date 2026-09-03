import { useProductUpdate } from "@/hooks/useProductUpdate";
import { useDesktopUpdate } from "@/hooks/useDesktopUpdate";

export default function StudioUpdateBanners({ onOpenAccount }) {
  const product = useProductUpdate();
  const desktop = useDesktopUpdate();
  const showDesktop = desktop.desktop && (desktop.ready || desktop.downloading);
  const showProduct = product.visible;
  if (!showDesktop && !showProduct) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-[420px] flex-col gap-2">
        {showDesktop ? (
          <div className="flex items-center gap-3 rounded-2xl border border-white/20 bg-black/55 px-3.5 py-2.5 text-white shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-snug">
                {desktop.ready
                  ? `LYKN ${desktop.pendingVersion || ""} is ready`.trim()
                  : "Downloading a LYKN update"}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-white/65">
                {desktop.ready
                  ? "Restart to install. Your work is saved."
                  : "This stays in the background."}
              </p>
            </div>
            {desktop.ready ? (
              <button
                type="button"
                onClick={() => void desktop.install()}
                className="shrink-0 rounded-full bg-white px-3 py-1 text-[12px] font-medium text-black"
              >
                Restart
              </button>
            ) : null}
          </div>
        ) : null}
        {showProduct ? (
          <div className="flex items-start gap-3 rounded-2xl border border-white/20 bg-black/55 px-3.5 py-2.5 text-white shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-snug">{product.update.title}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-white/65">
                {product.update.summary}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {typeof onOpenAccount === "function" ? (
                <button
                  type="button"
                  onClick={onOpenAccount}
                  className="rounded-full bg-white px-3 py-1 text-[12px] font-medium text-black"
                >
                  Open
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void product.dismiss()}
                className="rounded-full px-2 py-1 text-[12px] font-medium text-white/70"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
