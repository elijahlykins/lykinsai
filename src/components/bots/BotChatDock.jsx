// The chat bar's Bot surface — no separate messaging place.
//
// Two pieces the home chat bar composes: the in-bar trigger showing who
// you're talking to, and the glass dropdown that picks a Bot (or LYKN
// itself). The conversation itself happens in the regular chat thread —
// a targeted send routes to the Bot's worker agent and its reply streams
// into the same thread as any other turn (see botChatBridge).
// State comes from the shared botsClient singleton, so this and the Bots
// window are two views of the same team.
import { ChevronDown, UserRoundPlus } from "lucide-react";
import BotAvatar, { BotMark, botMood, botPresence } from "@/components/bots/BotAvatar";
import { botSeed } from "@/lib/bots/botStore";
import lyknIconNeutral from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-master.png";
import lyknIconBlue from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-BLUE-master.png";

// Shared with the bar and the desktop's right-click menus.
const SURFACE = "lg-desktop-surface";

/** The in-bar button: LYKN by default, the targeted Bot's face otherwise.
 *  Just the face — presence dots live in the dropdown only. */
export function BotTargetTrigger({ bot, agent, live, open, onClick, title, label }) {
  const fallbackTitle = bot ? `Talking to ${bot.name}, switch` : "Talk to a Bot";
  const fallbackLabel = bot ? `Talking to ${bot.name}` : "Talk to a Bot";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || fallbackTitle}
      aria-label={label || fallbackLabel}
      aria-expanded={open}
      className={`relative flex h-8 shrink-0 items-center gap-1 rounded-full pl-1.5 pr-1 transition-colors ${
        open
          ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white/90"
          : "text-black/60 hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90"
      }`}
    >
      {bot ? (
        <BotAvatar
          face={bot.face}
          eyes={bot.eyes}
          color={bot.color}
          size={22}
          mood={botMood(bot, agent, live)}
          seed={botSeed(bot.id)}
        />
      ) : (
        <BotMark className="h-[19px] w-[19px]" />
      )}
      <ChevronDown className="h-3 w-3 shrink-0 opacity-40" />
    </button>
  );
}
/** The glass dropdown: LYKN, then every Bot with presence, then New Bot. */
export function BotTargetMenu({
  bots,
  agentStates,
  live,
  targetBotId,
  /** Bot id on this browser tab (`""` = LYKN). Null when not in the browser. */
  screenOwnerId = null,
  onPick,
  onNewBot,
  panelRef,
  style,
}) {
  return (
    <div
      ref={panelRef}
      style={style}
      className={`pointer-events-auto absolute z-40 w-56 rounded-[14px] p-1.5 ${SURFACE}`}
    >
      <button
        type="button"
        data-active={!targetBotId || undefined}
        onClick={() => onPick("")}
        className={`lg-menu-row flex w-full items-center gap-2.5 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] ${
          !targetBotId ? "font-medium text-black dark:text-white" : "text-black/70 dark:text-white/75"
        }`}
      >
        <img
          src={lyknIconBlue}
          alt=""
          draggable={false}
          className="h-[22px] w-[22px] shrink-0 object-contain dark:hidden"
        />
        <img
          src={lyknIconNeutral}
          alt=""
          draggable={false}
          className="hidden h-[22px] w-[22px] shrink-0 object-contain dark:block"
        />
        LYKN
        <span className="ml-auto text-[0.62rem] text-black/35 dark:text-white/35">
          {screenOwnerId === "" ? "This screen" : "Chat"}
        </span>
      </button>

      {bots.length > 0 ? (
        <div className="mx-2 my-1 border-t border-black/[0.07] dark:border-white/[0.08]" />
      ) : null}

      {bots.map((bot) => {
        const agent = agentStates[bot.agentId];
        const liveState = live[bot.agentId];
        const presence = botPresence(bot, agent, liveState);
        const on = bot.id === targetBotId;
        return (
          <button
            key={bot.id}
            type="button"
            data-active={on || undefined}
            onClick={() => onPick(bot.id)}
            className={`lg-menu-row flex w-full items-center gap-2.5 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] ${
              on ? "font-medium text-black dark:text-white" : "text-black/70 dark:text-white/75"
            }`}
          >
            <BotAvatar
              face={bot.face}
              eyes={bot.eyes}
              color={bot.color}
              size={22}
              mood={botMood(bot, agent, liveState)}
              seed={botSeed(bot.id)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{bot.name}</span>
              <span className="flex items-center gap-1 text-[0.62rem] text-black/40 dark:text-white/40">
                <span className={`h-1 w-1 shrink-0 rounded-full ${presence.dot}`} />
                <span className="truncate">
                  {screenOwnerId && bot.id === screenOwnerId ? "This screen" : presence.label}
                </span>
              </span>
            </span>
          </button>
        );
      })}

      <div className="mx-2 my-1 border-t border-black/[0.07] dark:border-white/[0.08]" />
      <button
        type="button"
        onClick={onNewBot}
        className="lg-menu-row flex w-full items-center gap-2.5 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] text-black/70 dark:text-white/75"
      >
        <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-dashed border-black/25 dark:border-white/25">
          <UserRoundPlus className="h-3 w-3 opacity-70" />
        </span>
        New Bot…
      </button>
    </div>
  );
}
/**
 * The tiny live viewport that floats just above the chat bar while a Bot
 * works the browser (a user-approved browser task). The Bot's tab stays
 * hidden; this little window mirrors it with a screenshot every beat or so.
 * Clicking it reveals the real tab the Bot is working in.
 */
export function BotBrowserPeek({
  bots,
  agentStates,
  shots,
  onOpen,
  excludeAgentId,
  onlyBotId,
}) {
  const skip = String(excludeAgentId || "").trim();
  const scoped = onlyBotId !== undefined && onlyBotId !== null;
  const want = scoped ? String(onlyBotId || "") : "";
  const items = (bots || []).filter((bot) => {
    if (!bot.agentId || bot.agentId === skip) return false;
    if (!agentStates?.[bot.agentId]?.botBrowser) return false;
    // Home chat: the peek belongs to the Bot whose board is on screen.
    // An empty onlyBotId is LYKN — no Bot preview follows that switch.
    if (scoped && bot.id !== want) return false;
    return true;
  });
  if (!items.length) return null;
  return (
    <div className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2.5 flex -translate-x-1/2 items-end gap-2">
      {items.map((bot) => {
        const shot = shots?.[bot.agentId];
        const host = (() => {
          try {
            return shot?.url ? new URL(shot.url).hostname.replace(/^www\./, "") : "";
          } catch {
            return "";
          }
        })();
        return (
          <button
            key={bot.id}
            type="button"
            title={`${bot.name} is working in the browser, click to open the tab`}
            aria-label={`${bot.name} is working in the browser, click to open the tab`}
            onClick={() => onOpen(bot)}
            className={`group relative h-[104px] w-44 overflow-hidden rounded-xl text-left shadow-lg ring-1 ring-black/10 transition-transform hover:scale-[1.03] dark:ring-white/15 ${SURFACE}`}
          >
            {shot?.dataUrl ? (
              <img
                src={shot.dataUrl}
                alt=""
                draggable={false}
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center px-3 text-center text-[0.65rem] leading-snug text-black/50 dark:text-white/50">
                Opening the browser…
              </span>
            )}
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/65 via-black/35 to-transparent px-2 pb-1.5 pt-4">
              <BotAvatar
                face={bot.face}
                eyes={bot.eyes}
                color={bot.color}
                size={14}
                mood="working"
                seed={botSeed(bot.id)}
              />
              <span className="min-w-0 flex-1 truncate text-[0.62rem] font-medium text-white/90">
                {bot.name}
                {host ? <span className="font-normal text-white/60"> - {host}</span> : null}
              </span>
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
            </span>
          </button>
        );
      })}
    </div>
  );
}

