/**
 * The chrome every Home widget shares: the frosted tile, its header, and the
 * empty state. Widgets fill whatever box the canvas hands them (the size the
 * user picked), so nothing in here carries a fixed width or height.
 */

// Widgets sit on the Home drag surface — no-drag restores their clicks.
export const NO_DRAG = { WebkitAppRegion: 'no-drag' };

export const WIDGET_SURFACE =
  'rounded-[1.35rem] border border-black/10 dark:border-white/10 ' +
  'bg-white/75 dark:bg-black/45 backdrop-blur-2xl ' +
  'shadow-[0_8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]';

export function WidgetFrame({ as: Tag = 'div', className = '', style, children, ...rest }) {
  return (
    <Tag
      style={{ ...NO_DRAG, ...style }}
      className={`${WIDGET_SURFACE} h-full w-full overflow-hidden ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** The small colored caption macOS widgets wear, with room for a + on the right. */
export function WidgetHeader({ label, tone = 'text-black/50 dark:text-white/50', action, onClick }) {
  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className="min-w-0 text-left disabled:cursor-default"
      >
        <p className={`truncate text-[0.62rem] font-bold uppercase tracking-[0.08em] ${tone}`}>
          {label}
        </p>
      </button>
      {action}
    </div>
  );
}

/** The round + every list widget puts next to its heading. */
export function WidgetAddButton({ title, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex flex-shrink-0 items-center justify-center text-black/70 transition-transform hover:scale-110 active:scale-95 dark:text-white"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );
}

export function WidgetEmpty({ icon: Icon, label, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-black/40 dark:text-white/40"
    >
      {Icon ? <Icon className="h-5 w-5" /> : null}
      <span className="px-2 text-center text-[0.68rem] leading-tight">{label}</span>
    </button>
  );
}

/** How many rows a list widget shows at each size. */
export function rowsForSize(size, { small = 3, medium = 3, large = 7 } = {}) {
  if (size === 'large') return large;
  if (size === 'medium') return medium;
  return small;
}
