import { arrangementFor, readDesktopIcons } from "./desktopOrder";
import { DESKTOP_ROOT, moveDesktopGroup } from "./desktopSelect";

/**
 * Tidy every icon on the Home desktop onto the grid.
 *
 * The new positions go out on the channel a group drag already uses, so each
 * of the three stores behind the desktop picks out the ids it recognises and
 * saves its own — exactly as it would if the user had dragged everything into
 * place by hand. See desktopOrder for why this works off the icons on screen.
 *
 * `by` is "kind", "name", "date", or null to keep the current order and only
 * straighten the alignment. Returns how many icons moved, so a caller can say
 * so — the AI tool reports it back to the model, which otherwise has no way to
 * know whether it worked.
 */
export function arrangeDesktop({ by = null } = {}) {
  if (typeof document === "undefined") return 0;
  const root = document.querySelector(DESKTOP_ROOT);
  if (!root) return 0;

  const icons = readDesktopIcons(root);
  if (!icons.length) return 0;

  moveDesktopGroup(
    arrangementFor(icons, by, { w: root.clientWidth, h: root.clientHeight }),
    true,
  );
  return icons.length;
}
