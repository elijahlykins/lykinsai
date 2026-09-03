import { useCallback, useEffect, useState } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  ACCENTS,
  ACCENT_CUSTOM_ID,
  CHAT_BAR_SHAPES,
  CHAT_BAR_SIZES,
  CHAT_BUBBLE_SHAPES,
  CHAT_SEND_ICONS,
  CHAT_SEND_SHAPES,
  CHAT_TEXT_SIZES,
  GLASS_BLUR_MAX,
  GLASS_BLUR_MIN,
  INKS,
  INK_CUSTOM_ID,
  TYPEFACES,
  accentById,
  accentSwatchBackground,
  applyAppearance,
  chatBarShapeById,
  chatBarSizeById,
  chatBubbleShapeById,
  chatSendShapeById,
  chatTextSizeById,
  inkById,
  inkColor,
  readAppearance,
  resetAppearance,
  saveAppearance,
} from '@/lib/appearance';
import { sendGlyph } from '@/lib/chatSendIcon';
import { isDarkTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

import HomeWidgetPicker from './HomeWidgetPicker';
import WallpaperSettings from './WallpaperSettings';
import { LG_SELECT, LG_SELECT_CONTENT, LG_SWITCH } from './glassTokens';

const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** The size presets, in the shape SegmentedControl reads. */
const asSteps = (presets) => presets.map((p) => ({ id: p.id, label: p.name }));
const TEXT_SIZE_STEPS = asSteps(CHAT_TEXT_SIZES);
const BAR_SIZE_STEPS = asSteps(CHAT_BAR_SIZES);

const TOGGLES = [
  {
    key: 'reduceMotion',
    label: 'Reduce motion',
    description: 'Cut transitions and animated backgrounds across the app.',
  },
  {
    key: 'highContrast',
    label: 'High contrast outlines',
    description: 'Firm up borders on glass panels, inputs, and menus.',
  },
  {
    key: 'rowDividers',
    label: 'Show row dividers',
    description: 'Hairlines between rows in grouped lists.',
  },
  {
    key: 'largeSidebarIcons',
    label: 'Use large sidebar icons',
    description: 'Roomier navigation rows with bigger glyphs.',
  },
];

function FieldLabel({ children, trailing }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <span className="text-[13px] font-medium text-black/80 dark:text-white/80">{children}</span>
      {trailing ? (
        <span className="text-[12px] text-black/40 dark:text-white/40">{trailing}</span>
      ) : null}
    </div>
  );
}

function SegmentedControl({ options, value, onChange, ariaLabel }) {
  const index = Math.max(0, options.findIndex((o) => o.id === value));
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="lg-segment"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="lg-segment-thumb"
        style={{
          left: 3,
          width: `calc((100% - 6px) / ${options.length})`,
          transform: `translateX(calc(${index} * 100%))`,
        }}
      />
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          data-active={value === option.id}
          onClick={() => onChange(option.id)}
          className="lg-segment-btn"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SectionHeading({ children, action }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-black/45 dark:text-white/40">
        {children}
      </h3>
      {action}
    </div>
  );
}

function SwatchPicker({ value, hue, onChange }) {
  const custom = accentById(ACCENT_CUSTOM_ID, hue);
  return (
    <div className="flex flex-wrap items-start gap-2 pb-5">
      {[...ACCENTS, custom].map((accent) => {
        const selected = accent.id === value;
        return (
          <span key={accent.id} className="relative flex flex-col items-center">
            <button
              type="button"
              onClick={() => onChange(accent.id)}
              data-selected={selected}
              aria-label={accent.name}
              aria-pressed={selected}
              title={accent.name}
              className="lg-swatch"
              style={{ background: accentSwatchBackground(accent) }}
            />
            {selected ? (
              <span
                className="absolute top-[31px] whitespace-nowrap text-[11.5px] font-medium"
                style={{ color: 'hsl(var(--lykn-accent))' }}
              >
                {accent.name}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** Chat-ink chips, each filled with the color the chat's words will become.
 *  Default shows the theme's own ink, since that's what picking it restores. */
function InkPicker({ value, hue, appearance, dark, onChange }) {
  const custom = inkById(INK_CUSTOM_ID, hue);
  return (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-6 pb-5">
      {[...INKS, custom].map((ink) => {
        const color = inkColor(ink, appearance) || (dark ? '0 0% 100%' : '0 0% 0%');
        const selected = ink.id === value;
        return (
          <span key={ink.id} className="relative flex flex-col items-center">
            <button
              type="button"
              onClick={() => onChange(ink.id)}
              data-selected={selected}
              aria-label={ink.name}
              aria-pressed={selected}
              title={ink.name}
              className="lg-swatch"
              style={{ background: `hsl(${color})` }}
            />
            {selected ? (
              <span
                className="absolute top-[31px] whitespace-nowrap text-[11.5px] font-medium"
                style={{ color: 'hsl(var(--lykn-accent))' }}
              >
                {ink.name}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** One labelled ink row: the chips, and the hue slider the Custom chip needs. */
function InkField({ label, hint, value, hue, hueLabel, appearance, dark, onChange, onHueChange }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <InkPicker value={value} hue={hue} appearance={appearance} dark={dark} onChange={onChange} />
      {value === INK_CUSTOM_ID ? (
        <div className="pb-3 pt-1">
          <FieldLabel trailing={`${hue}°`}>Hue</FieldLabel>
          <Slider
            aria-label={hueLabel}
            min={0}
            max={359}
            step={1}
            value={[hue]}
            onValueChange={([next]) => onHueChange(next)}
          />
        </div>
      ) : null}
      {hint ? (
        <p className="text-[11px] leading-snug text-black/40 dark:text-white/35">{hint}</p>
      ) : null}
    </div>
  );
}

/** One labelled row of size steps. */
function SizeField({ label, steps, value, onChange }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <SegmentedControl ariaLabel={label} options={steps} value={value} onChange={onChange} />
    </div>
  );
}

/** Corner chips. Each is drawn as the shape it stands for, so the control
 *  shows the choice rather than naming it — a shape that also makes the bar
 *  taller gets a taller chip, and one whose radius would swallow a chip whole
 *  draws the `chipRadius` that reads the same at this scale.
 *
 *  `variant="bar"` draws the chips as mini Home bars (wide, short, pill vs
 *  box vs tall slate) instead of the smaller bubble tiles.
 *
 *  `glyph` fills each chip, for the send button, whose shape means little as
 *  an empty box; `square` sizes the chips for it, since a round send button
 *  drawn on the wide bar chip would come out an ellipse. */
function ShapePicker({ shapes, value, glyph: Glyph, square, variant, onChange }) {
  return (
    <div className="flex flex-wrap items-start gap-2.5 pb-6">
      {shapes.map((shape) => {
        const selected = shape.id === value;
        return (
          <span key={shape.id} className="relative flex flex-col items-center">
            <button
              type="button"
              onClick={() => onChange(shape.id)}
              data-selected={selected}
              data-tall={shape.minH ? 'true' : undefined}
              data-square={square ? 'true' : undefined}
              data-bar-shape={variant === 'bar' ? shape.id : undefined}
              aria-label={shape.name}
              aria-pressed={selected}
              title={shape.name}
              className={cn('lg-shape', Glyph && 'flex items-center justify-center')}
              style={{ borderRadius: shape.chipRadius || shape.radius }}
            >
              {Glyph ? (
                <Glyph
                  className="h-4 w-4 text-black/70 dark:text-white/75"
                  strokeWidth={2.25}
                />
              ) : null}
            </button>
            {selected ? (
              <span
                className="absolute top-full mt-1.5 whitespace-nowrap text-[11.5px] font-medium"
                style={{ color: 'hsl(var(--lykn-accent))' }}
              >
                {shape.name}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** The glyphs, each in the button shape that's already chosen — so the row
 *  reads as the real send button wearing six different arrows. */
function SendIconPicker({ icons, value, shape, onChange }) {
  return (
    <div className="flex flex-wrap items-start gap-2.5 pb-6">
      {icons.map((icon) => {
        const Glyph = sendGlyph(icon.id);
        const selected = icon.id === value;
        return (
          <span key={icon.id} className="relative flex flex-col items-center">
            <button
              type="button"
              onClick={() => onChange(icon.id)}
              data-selected={selected}
              data-square="true"
              aria-label={icon.name}
              aria-pressed={selected}
              title={icon.name}
              className="lg-shape flex items-center justify-center"
              style={{ borderRadius: shape.chipRadius || shape.radius }}
            >
              <Glyph className="h-4 w-4 text-black/70 dark:text-white/75" strokeWidth={2.25} />
            </button>
            {selected ? (
              <span
                className="absolute top-full mt-1.5 whitespace-nowrap text-[11.5px] font-medium"
                style={{ color: 'hsl(var(--lykn-accent))' }}
              >
                {icon.name}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** Home-bar silhouette for a given appearance. Default is a pill because
 *  that's the rounded bar at rest; Rectangle is a flat outlined box; Slate
 *  is the tall stacked field. The page composer stays 14px on Default —
 *  these three only really diverge on the Home bar, which is what the
 *  preview has to draw if the chips are going to mean anything. */
function barPreviewLook(appearance, { compact } = {}) {
  const barSize = chatBarSizeById(appearance.chatBarSize);
  const barShape = chatBarShapeById(appearance.chatBarShape);
  const slate = barShape.id === 'slate';
  const rectangle = barShape.id === 'rectangle';
  const pad = Math.max(barSize.pad, barShape.pad || 0);
  const minH = Math.max(barSize.minH, barShape.minH || 0);
  const scale = compact ? 0.55 : 1;
  return {
    barSize,
    barShape,
    slate,
    rectangle,
    radius: barShape.id === 'soft' ? '9999px' : barShape.radius,
    font: Math.max(9, barSize.font * scale),
    minH: Math.round((slate ? Math.min(minH, 92) : barSize.minH) * scale),
    padY: Math.round(Math.min(pad, slate ? 14 : 10) * scale),
    padX: compact ? 8 : 12,
    send: compact ? 16 : 24,
    rectangleSkin: rectangle
      ? {
          background: 'var(--lg-tint)',
          boxShadow: 'none',
          border: '1px solid var(--lg-hairline)',
        }
      : null,
  };
}

/** A transcript and a composer wearing the real chat classes, at the exact
 *  sizes and radii the choices below resolve to. The classes bring the ink and
 *  bubble tokens along; the geometry is set inline, which is what lets the
 *  preview show a size or shape that is still the default everywhere else. */
function ChatPreview({ appearance }) {
  const userSize = chatTextSizeById(appearance.chatUserTextSize);
  const aiSize = chatTextSizeById(appearance.chatAiTextSize);
  const bubbleShape = chatBubbleShapeById(appearance.chatBubbleShape);
  const sendShape = chatSendShapeById(appearance.chatSendShape);
  const SendGlyph = sendGlyph(appearance.chatSendIcon);
  const bar = barPreviewLook(appearance);
  return (
    <div className="lykn-chat-ink mb-4 space-y-2.5 rounded-[12px] border border-black/[0.07] bg-black/[0.02] p-3 dark:border-white/[0.09] dark:bg-white/[0.03]">
      <div className="flex justify-end">
        <div
          className="lykn-user-prompt-bubble max-w-[80%] border border-black/8 bg-background px-3 py-1 leading-[1.25] text-black/90 shadow-[0_2px_8px_rgba(0,0,0,0.045)] dark:border-white/10 dark:text-white/90"
          style={{ borderRadius: bubbleShape.radius, fontSize: userSize.px }}
        >
          What's on my calendar today?
        </div>
      </div>
      <p
        className="leading-[1.35] text-black/85 dark:text-white/85"
        style={{ fontSize: aiSize.px }}
      >
        Three things: a design review at 10, lunch with Ana at 12:30, and the
        investor call you moved to 4.
      </p>
      <div
        className={cn(
          'lykn-chat-neu-chat-shell flex gap-2 transition-[border-radius,padding,min-height,background,box-shadow] duration-200',
          bar.slate ? 'flex-col items-stretch justify-between' : 'items-center',
        )}
        data-shape={bar.barShape.id}
        style={{
          borderRadius: bar.radius,
          padding: `${bar.padY}px ${bar.padX}px${bar.slate ? ' 8px' : ''}`,
          minHeight: bar.minH,
          ...bar.rectangleSkin,
        }}
      >
        <span
          className="min-w-0 flex-1 px-1 text-black/45 dark:text-white/40"
          style={{ fontSize: bar.font, lineHeight: 1.45 }}
        >
          Ask me anything...
        </span>
        <span
          aria-hidden
          className={cn(
            'flex shrink-0 items-center justify-center',
            bar.slate && 'self-end',
          )}
          style={{
            width: bar.send,
            height: bar.send,
            background: 'hsl(var(--lykn-accent))',
            color: 'hsl(var(--lykn-accent-fg))',
            // Default has no radius of its own; the composer's own 10px block
            // is what it resolves to on the bar this preview is drawing.
            borderRadius: sendShape.radius || '10px',
          }}
        >
          <SendGlyph className="h-3.5 w-3.5" strokeWidth={2.25} />
        </span>
      </div>
    </div>
  );
}

/** Miniature of the app rendered with the pending tokens, sitting on the
 *  wallpaper so dim and blur read as more than numbers. The Home chat bar
 *  sits under the window so rectangle / slate / the round pill actually
 *  show up in this column. */
function LivePreview({ accent, photo, dim, blur, appearance }) {
  const accentColor = `hsl(${accent.hsl})`;
  const backdrop = photo
    ? { backgroundImage: `url(${photo})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: 'linear-gradient(155deg, #23262c 0%, #0e1013 100%)' };
  return (
    <div className="relative overflow-hidden rounded-[14px]" style={{ padding: 14 }}>
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ ...backdrop, filter: blur ? `blur(${Math.round(blur / 2)}px)` : undefined }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: `rgba(10,11,14,${(dim || 0) / 100})` }}
      />
      <div className="lg-preview relative overflow-hidden rounded-[12px]">
      <div className="flex h-[204px]">
        <div className="flex w-[86px] shrink-0 flex-col gap-1.5 border-r border-black/[0.06] p-2.5 dark:border-white/[0.08]">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="h-4 w-4 rounded-full" style={{ background: accentColor }} />
            <span className="h-1.5 w-9 rounded-full bg-black/20 dark:bg-white/25" />
          </div>
          {['Home', 'Projects', 'Vault'].map((row, i) => (
            <div
              key={row}
              className="flex items-center gap-1.5 rounded-[6px] px-1 py-[3px]"
              style={{ background: i === 0 ? 'hsl(var(--lykn-accent) / 0.22)' : 'transparent' }}
            >
              <span
                className="h-[7px] w-[7px] rounded-[2px]"
                style={{ background: i === 0 ? accentColor : 'currentColor', opacity: i === 0 ? 1 : 0.3 }}
              />
              <span className="text-[8px] leading-none text-black/60 dark:text-white/60">{row}</span>
            </div>
          ))}
        </div>

        <div className="min-w-0 flex-1 space-y-2 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-black/75 dark:text-white/80">Project</span>
            <span
              className="rounded-[5px] px-1.5 py-[3px] text-[7.5px] font-medium text-white"
              style={{ background: accentColor }}
            >
              New task
            </span>
          </div>
          {[0, 1].map((card) => (
            <div
              key={card}
              className="space-y-1.5 rounded-[8px] border border-black/[0.06] bg-white/50 p-2 dark:border-white/[0.08] dark:bg-white/[0.06]"
            >
              <span className="block h-1.5 w-2/3 rounded-full bg-black/20 dark:bg-white/25" />
              <span className="block h-1.5 w-1/2 rounded-full bg-black/10 dark:bg-white/12" />
              <div className="flex items-center gap-1 pt-0.5">
                <span className="h-3 w-3 rounded-full bg-black/15 dark:bg-white/20" />
                <span className="h-1 w-6 rounded-full bg-black/10 dark:bg-white/12" />
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>
      {appearance ? <HomeBarPreview appearance={appearance} accent={accent} /> : null}
    </div>
  );
}

/** Tiny Home chat bar for the wallpaper preview — same silhouettes as the
 *  chips and the AI-chat mock, scaled to the 244px column. */
function HomeBarPreview({ appearance, accent }) {
  const bar = barPreviewLook(appearance, { compact: true });
  const sendShape = chatSendShapeById(appearance.chatSendShape);
  const SendGlyph = sendGlyph(appearance.chatSendIcon);
  return (
    <div
      className={cn(
        'relative mx-auto mt-3 flex w-[88%] gap-1.5 transition-[border-radius,min-height,padding] duration-200',
        bar.slate ? 'flex-col items-stretch justify-between' : 'items-center',
        !bar.rectangle && 'lykn-chat-neu-chat-shell',
      )}
      data-shape={bar.barShape.id}
      style={{
        borderRadius: bar.radius,
        padding: bar.slate ? '7px 8px 6px' : '5px 8px',
        minHeight: bar.slate ? 46 : 28,
        ...bar.rectangleSkin,
      }}
    >
      <span
        className="min-w-0 flex-1 truncate text-black/40 dark:text-white/40"
        style={{ fontSize: bar.font }}
      >
        Ask me anything...
      </span>
      <span
        aria-hidden
        className={cn('flex shrink-0 items-center justify-center', bar.slate && 'self-end')}
        style={{
          width: 14,
          height: 14,
          background: `hsl(${accent.hsl})`,
          color: 'hsl(var(--lykn-accent-fg))',
          borderRadius: sendShape.radius || '10px',
        }}
      >
        <SendGlyph className="h-2.5 w-2.5" strokeWidth={2.4} />
      </span>
    </div>
  );
}

export default function AppearanceSettings({
  theme,
  onThemeChange,
  homeWidgets,
  onHomeWidgetToggle,
}) {
  const [appearance, setAppearance] = useState(readAppearance);
  const [savedAt, setSavedAt] = useState(0);
  // The Mac-synced photo, so the preview and the "Default" tile can show it.
  const [photo, setPhoto] = useState('');

  const update = useCallback((patch) => {
    setAppearance(saveAppearance(patch));
    setSavedAt(Date.now());
  }, []);

  // The tokens are painted at boot; re-assert them here so the controls can
  // never disagree with the live document (another window, or a reset from
  // Advanced while this pane was already mounted).
  useEffect(() => {
    applyAppearance(readAppearance());
  }, []);

  useEffect(() => {
    const b = typeof window === 'undefined' ? null : window.lykn;
    if (!b?.backgroundGet) return undefined;
    let cancelled = false;
    b.backgroundGet()
      .then((r) => {
        if (!cancelled && r?.ok) setPhoto(r.dataUrl || '');
      })
      .catch(() => {});
    const off = b.onBackgroundChanged?.((p) => setPhoto(p?.dataUrl || ''));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (!savedAt) return undefined;
    const timer = setTimeout(() => setSavedAt(0), 2200);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const accent = accentById(appearance.accent, appearance.accentHue);
  const dark = isDarkTheme(theme);

  return (
    <div className="relative flex flex-wrap items-start gap-x-10 gap-y-6">
      <div className="min-w-[300px] flex-1 space-y-6">
        <section>
          <FieldLabel>Theme</FieldLabel>
          <SegmentedControl
            ariaLabel="Theme"
            options={THEMES}
            value={theme || 'dark'}
            onChange={(next) => {
              onThemeChange?.(next);
              setSavedAt(Date.now());
            }}
          />
        </section>

        <section>
          <FieldLabel>Swatch</FieldLabel>
          <SwatchPicker
            value={appearance.accent}
            hue={appearance.accentHue}
            onChange={(id) => update({ accent: id })}
          />
          {appearance.accent === ACCENT_CUSTOM_ID ? (
            <div className="pt-1">
              <FieldLabel trailing={`${appearance.accentHue}°`}>Hue</FieldLabel>
              <Slider
                aria-label="Accent hue"
                min={0}
                max={359}
                step={1}
                value={[appearance.accentHue]}
                onValueChange={([next]) => update({ accentHue: next })}
              />
            </div>
          ) : null}
        </section>

        <div className="h-px w-full bg-black/[0.08] dark:bg-white/[0.1]" />

        <section>
          <SectionHeading>Wallpaper</SectionHeading>
          <WallpaperSettings appearance={appearance} onChange={update} />
        </section>

        {onHomeWidgetToggle ? (
          <>
            <div className="h-px w-full bg-black/[0.08] dark:bg-white/[0.1]" />
            <section>
              <SectionHeading>Home widgets</SectionHeading>
              <HomeWidgetPicker value={homeWidgets} onToggle={onHomeWidgetToggle} />
              <p className="mt-2 text-[11px] leading-snug text-black/40 dark:text-white/35">
                Hold a widget on the Home desktop to move it, resize it, or add
                another, including one for any app on your Mac.
              </p>
            </section>
          </>
        ) : null}

        <div className="h-px w-full bg-black/[0.08] dark:bg-white/[0.1]" />

        <section>
          <SectionHeading>Interface</SectionHeading>
          <FieldLabel>Typeface</FieldLabel>
          <Select value={appearance.typeface} onValueChange={(next) => update({ typeface: next })}>
            <SelectTrigger className={LG_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={LG_SELECT_CONTENT}>
              {TYPEFACES.map((face) => (
                <SelectItem key={face.id} value={face.id}>
                  <span style={{ fontFamily: face.stack }}>{face.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        <section>
          <FieldLabel trailing={`${appearance.glassBlur}px`}>Glass depth</FieldLabel>
          <Slider
            aria-label="Glass depth"
            min={GLASS_BLUR_MIN}
            max={GLASS_BLUR_MAX}
            step={2}
            value={[appearance.glassBlur]}
            onValueChange={([next]) => update({ glassBlur: next })}
          />
          <p className="mt-1.5 text-[11px] leading-snug text-black/40 dark:text-white/35">
            How much every frosted panel, menu, and tooltip blurs what's behind it.
          </p>
        </section>

        <div className="h-px w-full bg-black/[0.08] dark:bg-white/[0.1]" />

        <section>
          <SectionHeading>AI chat</SectionHeading>
          <ChatPreview appearance={appearance} />

          <div className="space-y-4">
            <SizeField
              label="Your text"
              steps={TEXT_SIZE_STEPS}
              value={appearance.chatUserTextSize}
              onChange={(id) => update({ chatUserTextSize: id })}
            />
            <SizeField
              label="LYKN's replies"
              steps={TEXT_SIZE_STEPS}
              value={appearance.chatAiTextSize}
              onChange={(id) => update({ chatAiTextSize: id })}
            />
            <SizeField
              label="Chat bar"
              steps={BAR_SIZE_STEPS}
              value={appearance.chatBarSize}
              onChange={(id) => update({ chatBarSize: id })}
            />
            <div>
              <FieldLabel>Message bubble shape</FieldLabel>
              <ShapePicker
                shapes={CHAT_BUBBLE_SHAPES}
                value={appearance.chatBubbleShape}
                onChange={(id) => update({ chatBubbleShape: id })}
              />
            </div>
            <div>
              <FieldLabel>Chat bar shape</FieldLabel>
              <ShapePicker
                shapes={CHAT_BAR_SHAPES}
                value={appearance.chatBarShape}
                variant="bar"
                onChange={(id) => update({ chatBarShape: id })}
              />
              <p className="text-[11px] leading-snug text-black/40 dark:text-white/35">
                Worn by both chat bars: the composer on the chat page and the
                rounded bar on the Home desktop.
              </p>
            </div>
            <div>
              <FieldLabel>Send button</FieldLabel>
              <SendIconPicker
                icons={CHAT_SEND_ICONS}
                value={appearance.chatSendIcon}
                shape={chatSendShapeById(appearance.chatSendShape)}
                onChange={(id) => update({ chatSendIcon: id })}
              />
              <ShapePicker
                shapes={CHAT_SEND_SHAPES}
                value={appearance.chatSendShape}
                glyph={sendGlyph(appearance.chatSendIcon)}
                square
                onChange={(id) => update({ chatSendShape: id })}
              />
              <p className="text-[11px] leading-snug text-black/40 dark:text-white/35">
                Default leaves each bar with the button it ships with: a block
                on the chat page, a circle on the Home desktop. Any other shape
                makes the two match.
              </p>
            </div>
          </div>

          <div className="my-5 h-px w-full bg-black/[0.06] dark:bg-white/[0.08]" />

          <div className="space-y-4">
            <InkField
              label="Your text"
              hueLabel="Your text hue"
              value={appearance.chatUserTextColor}
              hue={appearance.chatUserTextHue}
              appearance={appearance}
              dark={dark}
              onChange={(id) => update({ chatUserTextColor: id })}
              onHueChange={(next) => update({ chatUserTextHue: next })}
            />
            <InkField
              label="Your message bubble"
              hueLabel="Message bubble hue"
              value={appearance.chatBubbleColor}
              hue={appearance.chatBubbleHue}
              appearance={appearance}
              dark={dark}
              onChange={(id) => update({ chatBubbleColor: id })}
              onHueChange={(next) => update({ chatBubbleHue: next })}
            />
            <InkField
              label="LYKN's replies"
              hueLabel="Reply text hue"
              value={appearance.chatAiTextColor}
              hue={appearance.chatAiTextHue}
              appearance={appearance}
              dark={dark}
              onChange={(id) => update({ chatAiTextColor: id })}
              onHueChange={(next) => update({ chatAiTextHue: next })}
              hint="Colors the conversation and nothing else in the app. Each color is used as picked in both light and dark, so the deep inks stay deep. Tint the bubble and leave its text on Default to have LYKN keep the words readable on top of it."
            />
          </div>
        </section>

        <div className="h-px w-full bg-black/[0.08] dark:bg-white/[0.1]" />

        <section className="space-y-3.5">
          {TOGGLES.map((toggle) => (
            <div key={toggle.key} className="flex items-start gap-3">
              <Switch
                checked={!!appearance[toggle.key]}
                onCheckedChange={(checked) => update({ [toggle.key]: checked })}
                aria-label={toggle.label}
                className={cn(LG_SWITCH, 'mt-0.5')}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] leading-snug text-black dark:text-white">{toggle.label}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-black/45 dark:text-white/40">
                  {toggle.description}
                </p>
              </div>
            </div>
          ))}
        </section>

        <div className="h-px w-full bg-black/[0.08] dark:bg-white/[0.1]" />

        <section className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-black/40 dark:text-white/35">
            Wallpaper, widgets, and everything above are stored on this device.
          </p>
          <button
            type="button"
            onClick={() => {
              setAppearance(resetAppearance());
              setSavedAt(Date.now());
            }}
            className="lg-stepper h-8 shrink-0 rounded-[10px] px-3 text-[12.5px] font-medium text-black/80 dark:text-white/85"
          >
            Restore defaults
          </button>
        </section>
      </div>

      <div className="lykn-appearance-preview w-[244px] shrink-0">
        <SectionHeading>Preview</SectionHeading>
        <LivePreview
          accent={accent}
          photo={photo}
          dim={appearance.wallpaperDim}
          blur={appearance.wallpaperBlur}
          appearance={appearance}
        />
        <p className="mt-2.5 text-[11px] leading-snug text-black/40 dark:text-white/35">
          The Home desktop, with your wallpaper, accent, and chat bar.
        </p>
      </div>

      {savedAt ? (
        <div className="pointer-events-none sticky bottom-1 flex w-full justify-end">
          <span
            role="status"
            className="lg-toast flex items-center gap-2 rounded-full px-3 py-1.5 text-[11.5px] font-medium text-black/70 dark:text-white/75"
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: 'hsl(var(--lykn-accent))' }}
            />
            Saved to this device
          </span>
        </div>
      ) : null}
    </div>
  );
}
