/**
 * Choosing the icon for an app LYKN built.
 *
 * The model names an icon in `app.json` and it is usually close, but the dock
 * is the user's own desk — an app they open every day should look the way they
 * expect it to. Picking here is remembered as *their* choice, so a later "add
 * dark mode" rebuild cannot reset it.
 *
 * A popover rather than a modal: the icon it changes has to stay on screen
 * beside the grid, or there is no way to tell whether the pick was right.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Search } from "lucide-react";
import {
  appIconLabel,
  canonicalIconName,
  defaultAppIcon,
  resolveAppIcon,
  searchAppIcons,
} from "@/lib/apps/appIcon";

/**
 * @param {{
 *   value?: string | null,
 *   seed?: string,
 *   onPick: (icon: string | null) => void,
 *   children: React.ReactNode,
 *   mode?: "trigger" | "anchor",
 *   open?: boolean,
 *   onOpenChange?: (open: boolean) => void,
 *   side?: "top" | "bottom" | "left" | "right",
 *   align?: "start" | "center" | "end",
 * }} props
 *   `value` is the current icon name, null when the app is on its default, and
 *   `seed` is the app id the default tile is derived from so it matches the
 *   dock. `mode` decides what the child does: "trigger" opens the picker,
 *   "anchor" only positions against it, for a child that already does
 *   something else when clicked (the dock's launch button, which must still
 *   launch). Leave `open` unset to let the picker manage itself.
 */
export default function AppIconPicker({
  value,
  seed,
  onPick,
  children,
  mode = "trigger",
  open: openProp = undefined,
  onOpenChange = undefined,
  side = "bottom",
  align = "start",
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp === undefined ? openState : openProp;
  const setOpen = (next) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  const [query, setQuery] = useState("");
  const listRef = useRef(null);
  const current = canonicalIconName(value);
  // The current icon leads the unfiltered grid even when it is not one of the
  // curated ones — otherwise an app whose manifest reached deeper into lucide
  // opens the picker with nothing selected.
  const names = useMemo(() => {
    const found = searchAppIcons(query);
    if (!current || found.includes(current)) return found;
    return query ? found : [current, ...found];
  }, [query, current]);
  const DefaultIcon = defaultAppIcon(seed);
  const Attach = mode === "anchor" ? Popover.Anchor : Popover.Trigger;

  // Every open starts from the full shelf; a search left over from last time
  // reads as "these are all the icons there are".
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Portaled popovers inside a Dialog lose the wheel to RemoveScroll, so the
  // grid scrolls itself.
  useEffect(() => {
    if (!open) return undefined;
    const el = listRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (el.scrollHeight <= el.clientHeight + 1) return;
      e.preventDefault();
      e.stopPropagation();
      el.scrollTop += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, names.length]);

  const choose = (name) => {
    onPick(name);
    setOpen(false);
  };

  const tile = (active) =>
    `grid h-8 w-8 place-items-center rounded-lg transition-colors ${
      active
        ? "bg-blue-500/15 text-blue-600 ring-1 ring-blue-500/40 dark:text-blue-400"
        : "text-black/65 hover:bg-black/[0.06] hover:text-black/90 dark:text-white/65 dark:hover:bg-white/[0.1] dark:hover:text-white"
    }`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Attach asChild>{children}</Attach>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          onClick={(e) => e.stopPropagation()}
          className="lg-menu z-[400] w-[19rem] p-2 duration-150 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-40" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search icons"
              className="w-full rounded-lg border border-black/10 bg-black/[0.03] py-1.5 pl-7 pr-2 text-[12px] outline-none placeholder:text-black/35 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/[0.06] dark:placeholder:text-white/35"
            />
          </div>

          <div
            ref={listRef}
            className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto overscroll-contain scrollbar-hide"
          >
            <button
              type="button"
              onClick={() => choose(null)}
              title="Default icon"
              aria-label="Default icon"
              className={`${tile(!current)} relative`}
            >
              <DefaultIcon className="h-[15px] w-[15px]" />
              <span className="absolute bottom-0.5 right-0.5 h-1 w-1 rounded-full bg-current opacity-50" />
            </button>
            {names.map((name) => {
              const Icon = resolveAppIcon(name);
              if (!Icon) return null;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => choose(name)}
                  title={appIconLabel(name)}
                  aria-label={appIconLabel(name)}
                  className={tile(current === name)}
                >
                  <Icon className="h-[15px] w-[15px]" />
                </button>
              );
            })}
            {names.length === 0 ? (
              <p className="col-span-8 px-1 py-4 text-center text-[12px] text-black/45 dark:text-white/45">
                No icon matches “{query}”.
              </p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
