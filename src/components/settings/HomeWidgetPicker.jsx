import { useEffect, useState } from 'react';

import { Switch } from '@/components/ui/switch';
import { HOME_WIDGET_DEFAULTS } from '@/components/macdesktop/DesktopWidgets';
import { WIDGET_TYPES } from '@/components/macdesktop/widgetCatalog';
import { isAppInstallAvailable } from '@/lib/apps/installApp';
import { hasMacApps } from '@/lib/macApps';
import {
  addWidget,
  readWidgetLayout,
  removeWidgetsOfType,
  subscribeWidgetLayout,
} from '@/lib/desktopWidgets';
import { cn } from '@/lib/utils';

import { LG_SWITCH } from './glassTokens';

/**
 * The Home-desktop widget gallery, shared by Settings › Appearance and
 * Settings › Workspace.
 *
 * Switching a widget on puts one on the desktop; switching it off takes every
 * copy away. Where each one sits and how big it is belongs to the desktop
 * itself — you arrange widgets by holding one, not by coming in here — so this
 * pane only decides what's out.
 *
 * `value` / `onToggle` still carry the Files desktop icon, which is an icon
 * rather than a widget and has no size or position of its own.
 */
function Row({ on, label, description, trailing }) {
  return (
    <div
      // The accent tint is inline: Tailwind drops arbitrary color values that
      // contain a slash, so `bg-[hsl(var(--x)/0.08)]` never emits.
      style={
        on
          ? {
              borderColor: 'hsl(var(--lykn-accent) / 0.5)',
              background: 'hsl(var(--lykn-accent) / 0.08)',
            }
          : undefined
      }
      className={cn(
        'flex items-start gap-2.5 rounded-[12px] border p-2.5 transition-colors',
        on ? '' : 'border-black/[0.08] dark:border-white/[0.1]',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium leading-snug text-black dark:text-white">{label}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-black/45 dark:text-white/40">
          {description}
        </p>
      </div>
      {trailing}
    </div>
  );
}

export default function HomeWidgetPicker({ value, onToggle }) {
  const [items, setItems] = useState(readWidgetLayout);
  useEffect(() => subscribeWidgetLayout(setItems), []);

  const countOf = (type) => items.filter((i) => i.type === type).length;
  const macApps = hasMacApps();
  const lyknApps = isAppInstallAvailable();
  const filesOn =
    typeof value?.files === 'boolean' ? value.files : (HOME_WIDGET_DEFAULTS.files ?? true);

  const toggle = (spec, on) => {
    if (on) addWidget(spec.type, { size: spec.defaultSize });
    else removeWidgetsOfType(spec.type);
  };

  return (
    <div className="space-y-2">
      <div className="lykn-settings-grid gap-2" style={{ '--lykn-settings-grid-min': '186px' }}>
        {WIDGET_TYPES.filter(
          (spec) =>
            !spec.desktopOnly ||
            (spec.pickApp && macApps) ||
            (spec.pickLyknApp && lyknApps),
        ).map((spec) => {
          const count = countOf(spec.type);
          return (
            <Row
              key={spec.type}
              on={count > 0}
              label={spec.label}
              description={spec.description}
              trailing={
                spec.repeatable ? (
                  <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-black/45 dark:text-white/40">
                    {count === 0 ? 'None' : `${count} on desktop`}
                  </span>
                ) : (
                  <Switch
                    checked={count > 0}
                    onCheckedChange={(checked) => toggle(spec, checked)}
                    aria-label={`${spec.label} widget`}
                    className={cn(LG_SWITCH, 'mt-0.5 shrink-0')}
                  />
                )
              }
            />
          );
        })}
      </div>

      {onToggle ? (
        <Row
          on={filesOn}
          label="Files icon"
          description="A desktop icon for your Mac files."
          trailing={
            <Switch
              checked={filesOn}
              onCheckedChange={(checked) => onToggle('files', checked)}
              aria-label="Files desktop icon"
              className={cn(LG_SWITCH, 'mt-0.5 shrink-0')}
            />
          }
        />
      ) : null}
    </div>
  );
}
