/** Shared liquid-glass control classes for the settings window. */

export const LG_SWITCH =
  'lg-switch h-[22px] w-[38px] border data-[state=checked]:bg-transparent data-[state=unchecked]:bg-transparent [&>span]:h-[18px] [&>span]:w-[18px] [&>span]:data-[state=checked]:translate-x-[16px] [&>span]:data-[state=unchecked]:translate-x-[2px]';

export const LG_SELECT =
  'lg-stepper h-8 w-full justify-between gap-2 rounded-[10px] border-0 px-3 py-0 text-[13px] font-normal shadow-none focus:ring-0 focus:ring-offset-0';

export const LG_SELECT_INLINE =
  'lg-stepper h-7 w-auto min-w-[7rem] max-w-[12rem] justify-end gap-1.5 rounded-[8px] border-0 px-2.5 py-0 text-[13px] font-normal shadow-none focus:ring-0 focus:ring-offset-0';

export const LG_SELECT_CONTENT = 'lg-menu p-1';

export const LG_FIELD =
  'lg-stepper h-8 w-full rounded-[10px] border-0 px-2.5 text-[13px] text-black outline-none dark:text-white placeholder:text-black/35 dark:placeholder:text-white/30';

/** Field that sits at the right edge of a row, next to inline selects. */
export const LG_FIELD_INLINE =
  'lg-stepper h-7 rounded-[8px] border-0 px-2.5 text-[13px] text-black outline-none dark:text-white placeholder:text-black/35 dark:placeholder:text-white/30';

/** One width for every inline control in a pane, so their edges line up. */
export const LG_INLINE_W = 'w-[11.5rem] min-w-[11.5rem] max-w-[11.5rem]';

export const LG_TEXTAREA =
  'lg-stepper min-h-0 w-full resize-none rounded-[10px] border-0 px-2.5 py-2 text-[13px] md:text-[13px] leading-relaxed text-black shadow-none outline-none dark:text-white placeholder:text-black/35 dark:placeholder:text-white/30 focus-visible:ring-0';
