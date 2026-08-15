import LyknTodosPanel from "@/components/todos/LyknTodosPanel";

// ────────────────────────────────────────────────────────────────────────
// LyknTodosPage — To-dos as its own Studio (and standalone) popup page.
// Same centered frost card as Calendar; the list body lives in LyknTodosPanel.
//
// `windowed`: hosted in a floating Home app window, which already provides
// the card (title bar, frost, rounded edges) — so the page drops its own.
// ────────────────────────────────────────────────────────────────────────

export default function LyknTodosPage({ windowed = false }) {
  return (
    <div
      className={`lykn-todos-page h-full min-h-0 overflow-hidden bg-transparent text-black dark:text-white ${
        windowed ? "" : "dark:bg-[#121214]"
      }`}
    >
      <div
        className={`flex h-full w-full flex-col ${
          windowed ? "px-4 pb-4 pt-2" : "mx-auto max-w-2xl px-6 py-8 sm:px-8"
        }`}
      >
        <div
          className={`flex min-h-0 flex-1 flex-col gap-4 ${
            windowed
              ? ""
              : "rounded-[1.75rem] border border-black/10 bg-white/80 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06] dark:shadow-[0_8px_32px_rgba(0,0,0,0.28)] sm:p-6"
          }`}
        >
          <div className="flex flex-col space-y-1 text-left">
            {/* The window's title bar already says "To-dos". */}
            {!windowed && (
              <h2 className="text-lg font-semibold leading-none tracking-tight text-black dark:text-white">
                To-dos
              </h2>
            )}
            <p className="text-[0.625rem] text-black/40 dark:text-white/40">
              Tasks you and LYKN are tracking. Ask LYKN in chat or voice to add, complete, or clear items. They sync here live.
            </p>
          </div>
          <LyknTodosPanel />
        </div>
      </div>
    </div>
  );
}
