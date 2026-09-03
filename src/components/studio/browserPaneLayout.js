/* Inner browser pane geometry: the floating window is 20px rounded and the
 * native chrome sits 6px in, so it wears 14px corners. The live page stays
 * square so it meets the tab strip flush. Electron clips every corner of a
 * WebContentsView with one integer and cannot round only the bottom. */

export const BROWSER_VIEW_RADIUS = 14;
export const BROWSER_TAB_STRIP_HEIGHT = 42;
export const BROWSER_CHROME_HEIGHT = 82;
