/* Inner browser pane geometry: the floating window is 20px rounded and the
 * native chrome sits 6px in, so it wears 14px corners. The live page uses
 * the same curve so the window's bottom is rounded. Electron clips every
 * corner of a WebContentsView with one integer. */

export const BROWSER_VIEW_RADIUS = 14;
export const BROWSER_TAB_STRIP_HEIGHT = 42;
export const BROWSER_CHROME_HEIGHT = 82;
