import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  LogOut,
  User,
  Lock,
  LayoutGrid,
  Bell,
  Palette,
  Keyboard,
  SlidersHorizontal,
  CreditCard,
  ChevronRight,
  Sparkles,
  Plug,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import BillingDialog from '@/components/billing/BillingDialog';
import ConnectionsAppGrid from '@/components/connections/ConnectionsAppGrid';
import { PrivacyBody } from '@/pages/Privacy';
import { CookiePolicyBody } from '@/pages/CookiePolicy';
import { DPABody } from '@/pages/DPA';
import { TermsBody } from '@/pages/Terms';
import ModelSelectOptions from '@/components/ModelSelectOptions';
import VoicePicker from '@/components/notes/VoicePicker';
import AppearanceSettings from '@/components/settings/AppearanceSettings';
import {
  LG_FIELD,
  LG_FIELD_INLINE,
  LG_INLINE_W,
  LG_SELECT_CONTENT,
  LG_SELECT_INLINE,
  LG_SWITCH,
  LG_TEXTAREA,
} from '@/components/settings/glassTokens';
import { useAuth } from '@/lib/SupabaseAuth';
import { supabase } from '@/lib/supabase';
import { toast } from '@/components/ui/use-toast';
import { useUserPlan } from '@/lib/useUserPlan';
import { isModelAllowedForPlan, canonicalizeModelId, defaultModelForTier } from '@/lib/modelTiers';
import { planLabel } from '@/lib/pricing-config';
import { API_BASE_URL } from '@/lib/api-config';
import { parseNightShiftTier } from '@/lib/stewardQueue';
import { STARTUP_BRIEF_DEFAULT } from '@/lib/brief';
import { applyTheme, normalizeTheme, readSavedTheme } from '@/lib/theme';
import { folderLabel, shortenHome, useDesktopMirrorSettings } from '@/lib/macDesktopSync';
import { useMacSync } from '@/lib/macSync';
import { HOME_WIDGET_DEFAULTS } from '@/components/macdesktop/DesktopWidgets';
import { WIDGET_TYPES } from '@/components/macdesktop/widgetCatalog';
import { hasMacApps } from '@/lib/macApps';
import {
  addWidget,
  readWidgetLayout,
  removeWidgetsOfType,
  subscribeWidgetLayout,
} from '@/lib/desktopWidgets';
import { DEFAULT_APPEARANCE, saveAppearance } from '@/lib/appearance';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { id: 'workspace', title: 'Workspace', icon: LayoutGrid, keywords: 'home desktop widgets todos projects sync mac folders layout local mode files access' },
  { id: 'assistant', title: 'Assistant', icon: Sparkles, keywords: 'ai model voice name instructions personality chat response length' },
  { id: 'notifications', title: 'Notifications', icon: Bell, keywords: 'night shift brief alerts overnight' },
  { id: 'privacy', title: 'Privacy', icon: Lock, keywords: 'policy cookies terms dpa legal sessions devices sign out' },
  { id: 'appearance', title: 'Appearance', icon: Palette, keywords: 'theme dark light system swatch accent color hue custom wallpaper background photo desktop widgets glass blur dim density typeface font corner radius motion contrast dividers icons' },
  { id: 'integrations', title: 'Integrations', icon: Plug, keywords: 'apps api mcp google slack notion connect connections' },
  { id: 'billing', title: 'Billing', icon: CreditCard, keywords: 'payment plan subscription stripe upgrade invoice cancel' },
  { id: 'keyboard', title: 'Keyboard', icon: Keyboard, keywords: 'shortcuts hotkey command overlay keys' },
  { id: 'advanced', title: 'Advanced', icon: SlidersHorizontal, keywords: 'import export reset defaults support help chatgpt claude zip' },
];

// Privacy pane. Each doc opens in a popup over Settings; `path` is both the
// public route and how a cross-link inside one doc finds its sibling.
const POLICY_DOCS = [
  { id: 'privacy', label: 'Privacy Policy', path: '/privacy', Body: PrivacyBody },
  { id: 'cookies', label: 'Cookie Policy', path: '/cookies', Body: CookiePolicyBody },
  { id: 'dpa', label: 'Data Processing Addendum', path: '/dpa', Body: DPABody },
  { id: 'terms', label: 'Terms of Service', path: '/terms', Body: TermsBody },
];

const VIEW_TITLES = {
  account: 'Account',
  workspace: 'Workspace',
  assistant: 'Assistant',
  notifications: 'Notifications',
  privacy: 'Privacy',
  appearance: 'Appearance',
  integrations: 'Integrations',
  billing: 'Billing',
  keyboard: 'Keyboard',
  advanced: 'Advanced',
};

// Existing callers deep-link with the pre-rename ids — Studio's SETTINGS_VIEWS,
// the desktop context menu ("Edit Widgets…"), /settings?section=connections.
const VIEW_ALIASES = {
  display: 'appearance',
  connections: 'integrations',
  payment: 'billing',
  aiPersonalization: 'assistant',
  import: 'advanced',
  help: 'advanced',
};

const resolveView = (id) => (VIEW_TITLES[id] ? id : VIEW_ALIASES[id] || 'account');

// Chat-history import is built but not shipped; Advanced shows it as "Soon"
// (the old Import nav row was disabled for the same reason).
const IMPORT_ENABLED = false;

const KEY_BINDINGS = [
  {
    keys: ['⌘', 'L'],
    label: 'Show or hide the LYKN overlay',
    description: 'Works from any app, even when LYKN is in the background.',
  },
  { keys: ['Return'], label: 'Send the current message' },
  { keys: ['Shift', 'Return'], label: 'New line without sending' },
  { keys: ['Esc'], label: 'Close the overlay, a dialog, or an open menu' },
];

function TrafficLight({ color, label, glyph, onClick }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className="flex h-3 w-3 items-center justify-center rounded-full transition-transform active:scale-90"
      style={{ background: color }}
    >
      <svg
        viewBox="0 0 10 10"
        className="h-2 w-2 opacity-0 transition-opacity group-hover/traffic:opacity-60 group-hover/win:opacity-60"
        stroke="rgba(0,0,0,0.75)"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      >
        <path d={glyph} />
      </svg>
    </button>
  );
}

function TrafficLights({ onClose, onMinimize, onZoom, drag }) {
  return (
    <div
      className="group/traffic flex touch-none select-none items-center gap-[8px] px-[14px] pt-[14px] pb-[10px]"
      {...(drag || {})}
    >
      <TrafficLight
        color="#ff5f57"
        label="Close settings"
        onClick={onClose}
        glyph="M2 2 L8 8 M8 2 L2 8"
      />
      <TrafficLight
        color="#febc2e"
        label="Minimize settings"
        onClick={onMinimize}
        glyph="M2 5 H8"
      />
      <TrafficLight
        color="#28c840"
        label="Zoom settings"
        onClick={onZoom}
        glyph="M2.5 7.5 L7.5 2.5 M3 3 H7 V7"
      />
    </div>
  );
}

/** Drag the hosting DesktopAppWindow from a chromeless page's own chrome. */
function useWindowDrag(controls) {
  const origin = useRef(null);
  const onPointerDown = (e) => {
    if (!controls?.current || e.button !== 0) return;
    if (e.target.closest('button, input, a, textarea, select, [role="button"]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    controls.current.dragStart();
  };
  const onPointerMove = (e) => {
    if (!origin.current || !controls?.current) return;
    controls.current.dragBy(e.clientX - origin.current.x, e.clientY - origin.current.y);
  };
  const onPointerUp = () => {
    if (!origin.current) return;
    origin.current = null;
    controls.current?.dragEnd();
  };
  const onDoubleClick = (e) => {
    if (e.target.closest('button, input, a, textarea, select, [role="button"]')) return;
    controls?.current?.zoom();
  };
  return { onPointerDown, onPointerMove, onPointerUp, onDoubleClick };
}

function SettingsGroup({ children, caption, className }) {
  return (
    <div className={className}>
      <div className="lykn-settings-group overflow-hidden rounded-[14px] divide-y divide-black/[0.06] dark:divide-white/[0.08]">
        {children}
      </div>
      {caption ? (
        <p className="mt-1.5 px-3 text-[11px] leading-snug text-black/45 dark:text-white/40">{caption}</p>
      ) : null}
    </div>
  );
}

/** Small caps heading that names the group of rows beneath it. */
function GroupLabel({ children }) {
  return (
    <p className="px-1 text-[11px] font-medium uppercase tracking-[0.04em] text-black/40 dark:text-white/35">
      {children}
    </p>
  );
}

function SettingsRow({ label, description, trailing, children, onClick, href, to, danger = false, disabled = false }) {
  const body = (
    <>
      <div className="min-w-0 flex-1 py-0.5">
        {label ? (
          <p className={cn(
            'text-[13px] leading-snug',
            danger ? 'text-red-600 dark:text-red-400' : 'text-black dark:text-white',
            disabled && 'opacity-50',
          )}>
            {label}
          </p>
        ) : null}
        {description ? (
          <p className="mt-0.5 text-[11px] leading-snug text-black/45 dark:text-white/40">{description}</p>
        ) : null}
        {children}
      </div>
      {trailing ? <div className="shrink-0 pl-3">{trailing}</div> : null}
    </>
  );

  const interactive = !!(onClick || href || to);
  const rowClass = cn(
    'flex w-full gap-3 px-3.5 py-[11px] text-left',
    children ? 'items-start' : 'items-center',
    interactive && !disabled && 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
    disabled && 'cursor-default',
  );

  if (to) {
    return (
      <Link to={to} onClick={onClick} className={rowClass}>
        {body}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={rowClass}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} className={rowClass}>
        {body}
      </button>
    );
  }
  return <div className={rowClass}>{body}</div>;
}

function SidebarItem({ item, active, onSelect }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      disabled={item.disabled}
      data-active={active || undefined}
      onClick={() => onSelect(item.id)}
      className={cn(
        'lg-nav-item flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-[6px] text-left',
        item.disabled && 'cursor-default opacity-45',
      )}
    >
      <Icon
        className="lg-nav-icon"
        strokeWidth={1.9}
        style={active ? { color: 'hsl(var(--lykn-accent))' } : undefined}
      />
      <span className={cn(
        'flex-1 truncate text-[13.5px] text-black dark:text-white',
        active && 'font-medium',
      )}>
        {item.title}
      </span>
      {item.disabled ? (
        <span className="text-[10px] text-black/35 dark:text-white/30">Soon</span>
      ) : null}
    </button>
  );
}

function KeyCap({ children }) {
  return (
    <kbd className="lg-stepper inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[7px] px-1.5 font-sans text-[11.5px] font-medium text-black/70 dark:text-white/75">
      {children}
    </kbd>
  );
}

export default function SettingsModal({
  isOpen,
  onClose,
  initialView = 'account',
  // Hosted inside a DesktopAppWindow: no portal, and the sidebar lights
  // drive that window's close / minimize / zoom / drag.
  embedded = false,
  windowControls = null,
}) {
  const { user, loading, signInWithOAuth, signOut } = useAuth();
  const {
    planId,
    modelTier,
    hasStripeCustomer,
    hasActiveSubscription,
    cancelAtPeriodEnd,
    currentPeriodEnd,
  } = useUserPlan();
  const nav = useNavigate();
  const location = useLocation();
  const [portalBusy, setPortalBusy] = useState(false);
  // Which tab of the billing popup is open ('usage' | 'topup' | 'plans'), or
  // null when it's closed. Nested inside this dialog like the policy viewer.
  const [billingTab, setBillingTab] = useState(null);

  // One of the keys in VIEW_TITLES; legacy ids arrive via VIEW_ALIASES.
  const [view, setView] = useState('account');
  const [navQuery, setNavQuery] = useState('');

  // ---- Import: chat-history .zip upload ----
  const [importFile, setImportFile] = useState(null);
  const [importStatus, setImportStatus] = useState('idle'); // idle | uploading | done | error
  const [importError, setImportError] = useState('');
  const [isDraggingImport, setIsDraggingImport] = useState(false);

  // ---- Night Shift (server preferences) ----
  const [nightShiftEnabled, setNightShiftEnabled] = useState(false);
  const [nightShiftTier, setNightShiftTier] = useState('brief');
  const [nightShiftLoading, setNightShiftLoading] = useState(false);
  const [nightShiftSaving, setNightShiftSaving] = useState(false);

  // Each visit starts on the requested view (Account unless a caller deep-links
  // one, e.g. the desktop menu opening Display), and resets on close.
  useEffect(() => {
    setView(isOpen ? resolveView(initialView) : 'account');
    if (!isOpen) {
      setNavQuery('');
      setBillingTab(null);
    }
  }, [isOpen, initialView]);

  const runWindow = (action, fallback) => {
    const fn = windowControls?.current?.[action];
    if (typeof fn === 'function') fn();
    else fallback?.();
  };
  const closeWindow = () => runWindow('close', onClose);
  const minimizeWindow = () => runWindow('minimize', onClose);
  const zoomWindow = () => runWindow('zoom');
  const titleDrag = useWindowDrag(windowControls);
  const closeWindowRef = useRef(closeWindow);
  closeWindowRef.current = closeWindow;

  useEffect(() => {
    if (!embedded || !isOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeWindowRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded, isOpen]);

  const loadNightShiftPref = useCallback(async () => {
    if (!user?.id) return;
    setNightShiftLoading(true);
    try {
      const sess = await supabase.auth.getSession();
      const token = sess?.data?.session?.access_token;
      if (!token) return;
      const res = await fetch(`${API_BASE_URL}/api/account/preferences`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.preferences) {
        setNightShiftEnabled(!!data.preferences.night_shift_enabled);
        setNightShiftTier(parseNightShiftTier(data.preferences.night_shift_tier));
      }
    } catch {
      /* ignore */
    } finally {
      setNightShiftLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (isOpen && view === 'notifications' && user?.id) void loadNightShiftPref();
  }, [isOpen, view, user?.id, loadNightShiftPref]);

  const toggleNightShift = async () => {
    if (!user?.id || nightShiftSaving) return;
    const next = !nightShiftEnabled;
    setNightShiftSaving(true);
    try {
      const sess = await supabase.auth.getSession();
      const token = sess?.data?.session?.access_token;
      if (!token) return;
      const res = await fetch(`${API_BASE_URL}/api/account/preferences`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ night_shift_enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.preferences) {
        setNightShiftEnabled(!!data.preferences.night_shift_enabled);
        setNightShiftTier(parseNightShiftTier(data.preferences.night_shift_tier));
      } else {
        toast({
          title: "Couldn't update Night Shift",
          description: "The setting didn't save. Please try again.",
          variant: 'destructive',
        });
      }
    } catch {
      toast({
        title: "Couldn't update Night Shift",
        description: "The setting didn't save. Please try again.",
        variant: 'destructive',
      });
    } finally {
      setNightShiftSaving(false);
    }
  };

  const setNightShiftTierPref = async (tier) => {
    if (!user?.id || nightShiftSaving || tier === nightShiftTier) return;
    setNightShiftSaving(true);
    try {
      const sess = await supabase.auth.getSession();
      const token = sess?.data?.session?.access_token;
      if (!token) return;
      const res = await fetch(`${API_BASE_URL}/api/account/preferences`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ night_shift_tier: tier }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.preferences) {
        setNightShiftTier(parseNightShiftTier(data.preferences.night_shift_tier));
      } else {
        toast({
          title: "Couldn't update Night Shift",
          description: "The tier didn't save. Please try again.",
          variant: 'destructive',
        });
      }
    } catch {
      toast({
        title: "Couldn't update Night Shift",
        description: "The tier didn't save. Please try again.",
        variant: 'destructive',
      });
    } finally {
      setNightShiftSaving(false);
    }
  };

  // Deep-link straight to the connect surface. The app dock's "+" and any
  // "connect an app" entry point route to /settings#connections (or
  // ?section=connections) so the user lands on the cards, not the main menu.
  useEffect(() => {
    if (!isOpen) return;
    const params = new URLSearchParams(location.search || '');
    const wantsConnections =
      (location.hash || '').replace(/^#/, '') === 'connections' ||
      params.get('section') === 'connections';
    if (wantsConnections) setView('integrations');
  }, [isOpen, location.hash, location.search]);

  const openBillingPortal = useCallback(async (flow) => {
    if (portalBusy) return;
    setPortalBusy(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/billing/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flow ? { flow } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.url) {
        throw new Error(json?.message || json?.error || `Portal failed: ${res.status}`);
      }
      window.location.href = json.url;
    } catch (err) {
      if (import.meta.env.DEV) console.error('[Settings] portal failed:', err);
      toast({
        variant: 'destructive',
        title: flow === 'cancel' ? "Couldn't open cancel flow" : 'Billing portal unavailable',
        description: err?.message || 'Could not open the billing portal.',
      });
      setPortalBusy(false);
    }
  }, [portalBusy]);

  const handleManageSubscription = useCallback(
    () => openBillingPortal(),
    [openBillingPortal],
  );

  const handleCancelSubscription = useCallback(
    () => openBillingPortal('cancel'),
    [openBillingPortal],
  );

  // ---- Local visual settings (theme/model) — still localStorage ----
  const [settings, setSettings] = useState({
    theme: readSavedTheme(),
    layoutDensity: 'comfortable',
    aiPersonality: 'balanced',
    aiDetailLevel: 'medium',
    aiModel: 'lykn',
    aiName: '',
    userPrompt: '',
    voicePrompt: '',
    voiceId: '',
    voiceName: '',
    responseLength: 'medium',
    startupBrief: STARTUP_BRIEF_DEFAULT,
    homeWidgets: { ...HOME_WIDGET_DEFAULTS },
  });

  // What's actually on the Home desktop right now. Its own store, because a
  // widget carries a position and a size that this settings blob has no shape
  // for — and because the desktop edits it while this pane is open.
  const [widgetLayout, setWidgetLayout] = useState(readWidgetLayout);
  useEffect(() => subscribeWidgetLayout(setWidgetLayout), []);

  // ---- Guest auth form (only shown when no `user`) ----
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [authError, setAuthError] = useState('');

  // ---- Account: display name + password change ----
  const initialDisplayName = useMemo(
    () => user?.user_metadata?.full_name || user?.user_metadata?.name || '',
    [user?.id, user?.user_metadata?.full_name, user?.user_metadata?.name],
  );
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [displayNameStatus, setDisplayNameStatus] = useState('idle');

  // ---- Account: sign-out-everywhere busy state ----
  // Separate from `handleLogout` so a double-click can't dispatch two
  // global revocations in flight. Busy stays true until onClose runs.
  const [signOutEverywhereBusy, setSignOutEverywhereBusy] = useState(false);

  useEffect(() => {
    setDisplayName(initialDisplayName);
  }, [initialDisplayName]);

  useEffect(() => {
    const loadSettings = () => {
      const saved = localStorage.getItem('lykinsai_settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          parsed.theme = normalizeTheme(parsed.theme);
          parsed.aiModel = canonicalizeModelId(parsed.aiModel)
            || defaultModelForTier(modelTier);
          parsed.startupBrief =
            typeof parsed.startupBrief === 'boolean'
              ? parsed.startupBrief
              : STARTUP_BRIEF_DEFAULT;
          parsed.homeWidgets = {
            ...HOME_WIDGET_DEFAULTS,
            ...(parsed.homeWidgets && typeof parsed.homeWidgets === 'object'
              ? parsed.homeWidgets
              : {}),
          };
          setSettings(parsed);
          applyTheme(parsed.theme);
        } catch (e) {
          if (import.meta.env.DEV) console.error('Error parsing settings:', e);
        }
      } else {
        applyTheme(readSavedTheme());
      }
    };

    loadSettings();
    if (isOpen) loadSettings();

    const handleSettingsChange = () => loadSettings();
    window.addEventListener('lykinsai_settings_changed', handleSettingsChange);
    return () => {
      window.removeEventListener('lykinsai_settings_changed', handleSettingsChange);
    };
  }, [isOpen, user, modelTier]);

  const persistSettings = (next) => {
    const normalized = { ...next, theme: normalizeTheme(next.theme) };
    // The Appearance pane owns `appearance` / `layoutDensity` in the same blob
    // and writes them directly, so keep whatever is on disk for those two keys
    // rather than overwriting them with this component's copy of the state.
    let blob = normalized;
    try {
      const saved = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      blob = {
        ...saved,
        ...normalized,
        appearance: saved.appearance ?? normalized.appearance,
        layoutDensity: saved.layoutDensity ?? normalized.layoutDensity,
      };
    } catch {
      /* fall back to writing just this component's state */
    }
    localStorage.setItem('lykinsai_settings', JSON.stringify(blob));
    applyTheme(blob.theme);
    window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
    window.dispatchEvent(new Event('storage'));
  };

  // Render-synced mirror of `settings` for blur/save handlers. Reading the
  // closed-over `settings` in onBlur can be one keystroke behind (the
  // onChange state update hasn't re-rendered yet), silently dropping the
  // last characters typed into assistant name / custom instructions.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const persistCurrentSettings = () => persistSettings(settingsRef.current);

  // Assistant pane. Fields already save when you click out of them, so the
  // button is really the confirmation: it flushes whatever is still focused
  // and says "Saved" for a beat.
  const [assistantSaved, setAssistantSaved] = useState(false);
  const assistantSavedTimer = useRef(null);
  useEffect(() => () => clearTimeout(assistantSavedTimer.current), []);
  const saveAssistantSettings = () => {
    persistCurrentSettings();
    setAssistantSaved(true);
    clearTimeout(assistantSavedTimer.current);
    assistantSavedTimer.current = setTimeout(() => setAssistantSaved(false), 2000);
  };

  // "Sync my Desktop" — mirrors the real Mac desktop onto Home. Desktop-app
  // only; the hook reports available: false in a browser.
  const macMirror = useDesktopMirrorSettings(settings.desktopSync, (desktopSync) => {
    const updated = { ...settingsRef.current, desktopSync };
    setSettings(updated);
    persistSettings(updated);
  });

  // "Sync with Mac" — the folders LYKN may read, same allowlist the welcome
  // flow sets up. Lives in the main process, so it has no settings blob.
  const macSync = useMacSync();

  // Which legal doc the Privacy pane is showing in a popup, if any.
  const [openPolicy, setOpenPolicy] = useState(null);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (authMode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        // Mirror the main Login page's signup handling: send confirmation
        // links back to this origin, and detect the "email already
        // registered" shape (Supabase returns a user with empty identities,
        // or confirmed + no session, instead of an error).
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/login` },
        });
        if (error) throw error;
        const u = data?.user;
        const emptyIdentities = !u?.identities || u.identities.length === 0;
        const alreadyConfirmed = !!(u?.email_confirmed_at || u?.confirmed_at);
        if ((u && emptyIdentities) || (u && !data?.session && alreadyConfirmed)) {
          setAuthError('An account with this email already exists. Try signing in instead.');
          return;
        }
        if (u && !data?.session) {
          setAuthError(`Check ${email} for a confirmation link to finish creating your account.`);
          return;
        }
      }
      setEmail('');
      setPassword('');
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('invalid login') || msg.includes('invalid credentials')) {
        setAuthError('Incorrect email or password. Please try again.');
      } else if (msg.includes('email not confirmed')) {
        setAuthError('Please confirm your email before signing in — check your inbox.');
      } else if (msg.includes('already registered') || msg.includes('already been registered')) {
        setAuthError('An account with this email already exists. Try signing in instead.');
      } else {
        setAuthError('Sign-in failed. Please check your email and password.');
      }
    }
  };

  const handleSaveDisplayName = async () => {
    const trimmed = displayName.trim();
    setDisplayNameStatus('saving');
    try {
      const { error } = await supabase.auth.updateUser({ data: { full_name: trimmed } });
      if (error) throw error;
      setDisplayNameStatus('saved');
      setTimeout(() => setDisplayNameStatus('idle'), 1500);
    } catch (e) {
      if (import.meta.env.DEV) console.error('[Settings] display name save failed:', e);
      setDisplayNameStatus('error');
      setTimeout(() => setDisplayNameStatus('idle'), 2000);
    }
  };

  const MAX_IMPORT_BYTES = 500 * 1024 * 1024; // 500 MB
  const isZipFile = (file) =>
    !!file && (
      file.type === 'application/zip' ||
      file.type === 'application/x-zip-compressed' ||
      /\.zip$/i.test(file.name)
    );

  const handleImportFileSelected = (file) => {
    setImportError('');
    setImportStatus('idle');
    if (!file) return;
    if (!isZipFile(file)) {
      setImportError('Please select a .zip export file.');
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setImportError('File is too large (max 500 MB).');
      return;
    }
    setImportFile(file);
  };

  const handleImportDrop = (e) => {
    e.preventDefault();
    setIsDraggingImport(false);
    const file = e.dataTransfer?.files?.[0];
    handleImportFileSelected(file);
  };

  const handleImportUpload = async () => {
    if (!importFile || importStatus === 'uploading') return;
    setImportStatus('uploading');
    setImportError('');
    try {
      const form = new FormData();
      form.append('file', importFile);
      const res = await fetch(`${API_BASE_URL}/api/import/chat-history`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.message || json?.error || `Upload failed (${res.status})`);
      }
      setImportStatus('done');
      setTimeout(() => {
        setImportFile(null);
        setImportStatus('idle');
      }, 2500);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[Settings] import upload failed:', err);
      setImportStatus('error');
      setImportError(err?.message || 'Upload failed. Please try again.');
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
    } finally {
      onClose();
    }
  };

  const handleSignOutEverywhere = async () => {
    if (signOutEverywhereBusy) return;
    // Native confirm is intentional here — this revokes every refresh
    // token on the account across every device, and we want the user
    // to read the consequence before it fires.
    const ok = window.confirm(
      'Sign out of every browser and device signed into this account?\n\n' +
      'You will need to sign in again everywhere. Use this if you suspect ' +
      'someone else has access to your account.',
    );
    if (!ok) return;
    setSignOutEverywhereBusy(true);
    try {
      await signOut({ everywhere: true });
    } finally {
      onClose();
    }
  };

  const filteredNav = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return NAV_ITEMS;
    return NAV_ITEMS.filter((item) =>
      `${item.title} ${item.keywords}`.toLowerCase().includes(q),
    );
  }, [navQuery]);

  const avatarUrl = user?.user_metadata?.avatar_url || user?.user_metadata?.picture || '';
  const profileName = (displayName || '').trim() || user?.email?.split('@')[0] || 'Account';
  const profileInitial = (profileName || '?').charAt(0).toUpperCase();
  const accountNeedle = navQuery.trim().toLowerCase();
  const showAccountCard = !accountNeedle || (
    'account profile sign in email name logout'.includes(accountNeedle)
    || profileName.toLowerCase().includes(accountNeedle)
    || String(user?.email || '').toLowerCase().includes(accountNeedle)
  );

  const chevron = <ChevronRight className="h-3.5 w-3.5 text-black/25 dark:text-white/30" />;
  const windowClass = embedded
    ? 'lykn-settings-window lykn-settings-embedded flex h-full w-full flex-row overflow-hidden text-black dark:text-white p-0 gap-0'
    : 'lykn-settings-window flex flex-row overflow-hidden text-black dark:text-white w-[min(940px,calc(100vw-24px))] h-[min(620px,92vh)] max-w-none p-0 gap-0 rounded-[26px] sm:rounded-[26px]';

  const renderAccount = () => (
    user ? (
      <div className="space-y-5">
        <SettingsGroup>
          <SettingsRow label="Email" trailing={
            <span className="max-w-[220px] truncate text-[13px] text-black/45 dark:text-white/45">{user.email}</span>
          } />
          <SettingsRow label="Display name" trailing={
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="h-7 w-[160px] px-2 text-[13px] text-right rounded-md bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.1] text-black dark:text-white placeholder:text-black/35 dark:placeholder:text-white/30 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleSaveDisplayName}
                disabled={displayNameStatus === 'saving' || displayName.trim() === initialDisplayName.trim()}
                className="text-[13px] font-medium text-[#007aff] disabled:opacity-30"
              >
                {displayNameStatus === 'saving'
                  ? 'Saving…'
                  : displayNameStatus === 'saved'
                    ? 'Saved'
                    : displayNameStatus === 'error'
                      ? 'Retry'
                      : 'Save'}
              </button>
            </div>
          } />
        </SettingsGroup>

        <SettingsGroup caption="Revokes every active session on your account. Use this if you suspect someone else has access.">
          <SettingsRow
            label={signOutEverywhereBusy ? 'Signing out everywhere…' : 'Sign out of all devices'}
            danger
            disabled={signOutEverywhereBusy}
            onClick={handleSignOutEverywhere}
            trailing={signOutEverywhereBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-red-400" /> : null}
          />
        </SettingsGroup>
      </div>
    ) : (
      <div className="space-y-5">
        <SettingsGroup>
          <SettingsRow
            label="Continue with Google"
            onClick={async () => {
              try {
                setAuthError('');
                const { error } = await signInWithOAuth('google');
                if (error) {
                  setAuthError('Google sign-in failed. Please try again.');
                  if (import.meta.env.DEV) console.error('Google OAuth error:', error);
                }
              } catch (error) {
                setAuthError('Google sign-in failed. Please try again later.');
                if (import.meta.env.DEV) console.error('Google OAuth exception:', error);
              }
            }}
            trailing={chevron}
          />
        </SettingsGroup>

        <form onSubmit={handleAuth} className="space-y-5">
          {authError && (
            <p className="px-1 text-[12px] text-red-500">{authError}</p>
          )}
          <SettingsGroup caption="Or continue with email.">
            <SettingsRow label="Email">
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`${LG_FIELD} mt-1.5`}
                required
              />
            </SettingsRow>
            <SettingsRow label="Password">
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${LG_FIELD} mt-1.5`}
                required
              />
            </SettingsRow>
          </SettingsGroup>
          <div className="flex items-center gap-4 px-1">
            <button
              type="submit"
              className="text-[13px] font-medium text-[#007aff]"
            >
              {authMode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
            <button
              type="button"
              onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
              className="text-[13px] text-black/45 dark:text-white/45 hover:text-black dark:hover:text-white"
            >
              {authMode === 'login' ? 'Create an account' : 'Have an account? Sign in'}
            </button>
          </div>
        </form>
      </div>
    )
  );

  const renderConnections = () => (
    <ConnectionsAppGrid user={user} embedded />
  );

  // A doc's cross-links (Privacy → Cookie Policy, …) swap the popup instead of
  // routing the app out from under the open Settings window.
  const handlePolicyLinkClick = (e) => {
    const anchor = e.target?.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const sibling = POLICY_DOCS.find((doc) => href.startsWith(doc.path));
    if (sibling) {
      e.preventDefault();
      setOpenPolicy(sibling.id);
      return;
    }
    if (href.startsWith('/')) onClose?.();
  };

  const renderPrivacy = () => {
    const doc = POLICY_DOCS.find((d) => d.id === openPolicy) || null;
    return (
      <div className="flex flex-col gap-px">
        {POLICY_DOCS.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setOpenPolicy(row.id)}
            className="flex w-full items-center gap-3 rounded-[10px] px-2 py-[9px] text-left text-[13px] text-black transition-colors hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.06]"
          >
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-black/25 dark:text-white/25" />
          </button>
        ))}

        <Dialog open={!!doc} onOpenChange={(open) => { if (!open) setOpenPolicy(null); }}>
          <DialogContent className="grid-rows-[auto_minmax(0,1fr)] max-w-2xl gap-0 overflow-hidden overflow-y-hidden p-0">
            <DialogTitle className="px-6 pb-3 pt-5 text-[15px]">{doc?.label}</DialogTitle>
            {/* The docs are written as full pages — drop the page chrome and
                scale the type down to popup size. */}
            <div
              onClick={handlePolicyLinkClick}
              className="lykn-settings-scroll min-h-0 overflow-y-auto px-6 pb-6 [&_article]:max-w-none [&_article]:space-y-6 [&_article]:px-0 [&_article]:py-0 [&_footer]:hidden [&_h1]:hidden [&_h2]:text-[15px] [&_h3]:text-[13.5px]"
            >
              {doc ? <doc.Body /> : null}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  };

  const setTheme = (value) => {
    const updated = { ...settings, theme: value };
    setSettings(updated);
    persistSettings(updated);
  };

  // The Files desktop icon rides on this component's settings blob, so both
  // panes that offer it go through here — a direct localStorage write from the
  // Appearance pane would be stomped by the next persistSettings from this
  // state. An icon the user has never touched is on if it ships on.
  const isHomeWidgetChecked = (id) =>
    typeof settings.homeWidgets?.[id] === 'boolean'
      ? settings.homeWidgets[id]
      : (HOME_WIDGET_DEFAULTS[id] ?? true);

  const toggleHomeWidget = (id, checked) => {
    const updated = {
      ...settings,
      homeWidgets: { ...(settings.homeWidgets || {}), [id]: checked },
    };
    setSettings(updated);
    persistSettings(updated);
  };

  const renderAppearance = () => (
    <AppearanceSettings
      theme={settings.theme || 'dark'}
      onThemeChange={setTheme}
      homeWidgets={settings.homeWidgets}
      onHomeWidgetToggle={toggleHomeWidget}
    />
  );

  const toggleStartupBrief = (checked) => {
    const updated = { ...settings, startupBrief: checked };
    setSettings(updated);
    persistSettings(updated);
  };

  const renderNotifications = () => (
    <div className="space-y-5">
      {user ? (
        <>
          <SettingsGroup caption="A brief slides in on the right each time you open LYKN. Press it to read your day — what's scheduled, what's due, and anything Night Shift left overnight.">
            <SettingsRow
              label="Brief on startup"
              trailing={
                <Switch
                  checked={!!settings.startupBrief}
                  onCheckedChange={toggleStartupBrief}
                  aria-label="Brief on startup"
                  className={LG_SWITCH}
                />
              }
            />
          </SettingsGroup>
          <SettingsGroup caption="Work on your projects overnight and leave a morning brief.">
            <SettingsRow
              label="Night Shift"
              trailing={
                <Switch
                  checked={nightShiftEnabled}
                  disabled={nightShiftLoading || nightShiftSaving}
                  onCheckedChange={() => void toggleNightShift()}
                  aria-label="Night Shift"
                  className={LG_SWITCH}
                />
              }
            />
            {nightShiftEnabled ? (
              <SettingsRow
                label="Depth"
                trailing={
                  <Select
                    value={nightShiftTier}
                    onValueChange={(value) => void setNightShiftTierPref(value)}
                    disabled={nightShiftSaving}
                  >
                    <SelectTrigger className={LG_SELECT_INLINE}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={LG_SELECT_CONTENT}>
                      <SelectItem value="brief">Brief</SelectItem>
                      <SelectItem value="research">Research</SelectItem>
                      <SelectItem value="delegate">Delegate</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
            ) : null}
          </SettingsGroup>
        </>
      ) : (
        <SettingsGroup caption="Sign in from Account to set up a brief.">
          <SettingsRow
            label="Go to Account"
            onClick={() => setView('account')}
            trailing={chevron}
          />
        </SettingsGroup>
      )}
    </div>
  );

  const renderWorkspace = () => (
    <div className="space-y-5">
      <SettingsGroup caption="What's out on the Home desktop. Where each widget sits and how big it is belongs to the desktop — hold one there to move, resize, or add another. Wallpaper lives in Appearance.">
        {WIDGET_TYPES.filter((spec) => !spec.desktopOnly || hasMacApps()).map((spec) => {
          const count = widgetLayout.filter((i) => i.type === spec.type).length;
          return (
            <SettingsRow
              key={spec.type}
              label={spec.label}
              description={spec.description}
              trailing={
                spec.repeatable ? (
                  // App widgets are added by picking an app, which happens on
                  // the desktop where you can see where it lands.
                  <span className="text-[11px] tabular-nums text-black/45 dark:text-white/40">
                    {count === 0 ? 'None' : `${count} on desktop`}
                  </span>
                ) : (
                  <Switch
                    checked={count > 0}
                    onCheckedChange={(checked) => {
                      if (checked) addWidget(spec.type, { size: spec.defaultSize });
                      else removeWidgetsOfType(spec.type);
                    }}
                    aria-label={`${spec.label} widget`}
                    className={LG_SWITCH}
                  />
                )
              }
            />
          );
        })}
        <SettingsRow
          label="Files icon"
          description="A desktop icon for your Mac files."
          trailing={
            <Switch
              checked={isHomeWidgetChecked('files')}
              onCheckedChange={(checked) => toggleHomeWidget('files', checked)}
              aria-label="Files desktop icon"
              className={LG_SWITCH}
            />
          }
        />
      </SettingsGroup>

      {macSync.available ? (
        <SettingsGroup caption="The folders LYKN can see on this Mac — the same access as Local mode in the Vault. Files never leave your computer: they open in place, and LYKN AI can read them when you ask.">
          <SettingsRow
            label="Sync with Mac"
            description={
              macSync.enabled
                ? 'On — LYKN can read the files you share below.'
                : 'Off — LYKN can’t read anything on this Mac.'
            }
            trailing={
              <Switch
                checked={macSync.enabled}
                disabled={macSync.busy}
                onCheckedChange={(checked) => macSync.requestToggle(checked)}
                aria-label="Sync with Mac"
                className={LG_SWITCH}
              />
            }
          />

          {macSync.confirming ? (
            <div className="px-3 py-2.5">
              <p className="text-[11px] leading-snug text-black/55 dark:text-white/50">
                Syncing lets LYKN read the files in the folders you pick. That
                turns on Local mode. Files stay on this Mac, and LYKN asks before
                anything is written, deleted, or changed.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={macSync.confirmEnable}
                  disabled={macSync.busy}
                  className="rounded-md bg-black px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-black"
                >
                  Turn on
                </button>
                <button
                  type="button"
                  onClick={macSync.cancelEnable}
                  className="rounded-md px-2.5 py-1 text-[12px] font-medium text-black/60 transition-colors hover:bg-black/[0.05] dark:text-white/60 dark:hover:bg-white/[0.08]"
                >
                  Not now
                </button>
              </div>
            </div>
          ) : null}

          {macSync.enabled ? (
            <SettingsRow
              label="Share my whole home folder"
              description={
                macSync.syncAll
                  ? 'LYKN can see everything in your home folder.'
                  : `LYKN can only see the ${macSync.folders.length} folder${macSync.folders.length === 1 ? '' : 's'} below.`
              }
              trailing={
                <Switch
                  checked={macSync.syncAll}
                  disabled={macSync.busy}
                  onCheckedChange={(checked) => macSync.setSyncAll(checked)}
                  aria-label="Share my whole home folder"
                  className={LG_SWITCH}
                />
              }
            />
          ) : null}

          {macSync.enabled && !macSync.syncAll
            ? macSync.folders.map((folder) => (
                <SettingsRow
                  key={folder}
                  label={folderLabel(folder)}
                  description={shortenHome(folder)}
                  trailing={
                    <button
                      type="button"
                      onClick={() => macSync.removeFolder(folder)}
                      aria-label={`Stop syncing ${folderLabel(folder)}`}
                      className="rounded p-0.5 text-black/35 transition-colors hover:text-black/80 dark:text-white/35 dark:hover:text-white/80"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  }
                />
              ))
            : null}

          {macSync.enabled && !macSync.syncAll ? (
            <SettingsRow
              label="Sync a folder…"
              description={macSync.empty ? "Nothing is synced yet — LYKN can't see any files." : undefined}
              disabled={macSync.busy}
              onClick={() => void macSync.addFolders()}
              trailing={chevron}
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {macMirror.available ? (
        <SettingsGroup caption="Your Mac desktop, shown on the LYKN Home desktop. Items open in the apps that own them — LYKN never moves, renames, or deletes them.">
          <SettingsRow
            label="Sync my Desktop"
            description={
              macMirror.blocked
                ? 'Local mode is off — turn it back on to see your files.'
                : 'Show the files and folders from your Mac desktop on Home.'
            }
            trailing={
              <Switch
                checked={macMirror.enabled}
                disabled={macMirror.busy}
                onCheckedChange={(checked) => macMirror.requestToggle(checked)}
                aria-label="Sync my Desktop"
                className={LG_SWITCH}
              />
            }
          />

          {macMirror.confirming ? (
            <div className="px-3 py-2.5">
              <p className="text-[11px] leading-snug text-black/55 dark:text-white/50">
                To show your desktop, LYKN needs to read the files on this Mac.
                That turns on Local mode. Files stay on your Mac, and LYKN asks
                before anything is written or changed.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={macMirror.confirmEnable}
                  disabled={macMirror.busy}
                  className="rounded-md bg-black px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-black"
                >
                  Turn on
                </button>
                <button
                  type="button"
                  onClick={macMirror.cancelEnable}
                  className="rounded-md px-2.5 py-1 text-[12px] font-medium text-black/60 transition-colors hover:bg-black/[0.05] dark:text-white/60 dark:hover:bg-white/[0.08]"
                >
                  Not now
                </button>
              </div>
            </div>
          ) : null}

          {macMirror.enabled
            ? macMirror.folders.map((folder) => (
                <SettingsRow
                  key={folder}
                  label={folderLabel(folder)}
                  description={shortenHome(folder)}
                  trailing={
                    <button
                      type="button"
                      onClick={() => macMirror.removeFolder(folder)}
                      aria-label={`Stop showing ${folderLabel(folder)} on Home`}
                      className="rounded p-0.5 text-black/35 transition-colors hover:text-black/80 dark:text-white/35 dark:hover:text-white/80"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  }
                />
              ))
            : null}

          {macMirror.enabled ? (
            <SettingsRow
              label="Show another folder…"
              disabled={macMirror.busy}
              onClick={() => void macMirror.addFolders()}
              trailing={chevron}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
    </div>
  );

  // Every control in this pane is either an inline pill on the right edge or a
  // full-width field under its label, so the rows line up down the pane.
  const renderAiPersonalization = () => (
    <div className="space-y-5">
      <GroupLabel>General</GroupLabel>
      <SettingsGroup>
        <SettingsRow
          label="Default model"
          trailing={
            <Select
              value={settings.aiModel}
              onValueChange={(value) => {
                if (!isModelAllowedForPlan(value, modelTier)) return;
                const updated = { ...settings, aiModel: value };
                setSettings(updated);
                persistSettings(updated);
              }}
            >
              <SelectTrigger className={cn(LG_SELECT_INLINE, LG_INLINE_W, 'justify-between')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={LG_SELECT_CONTENT}>
                <ModelSelectOptions modelTier={modelTier} />
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label="Assistant name"
          trailing={
            <input
              type="text"
              value={settings.aiName || ''}
              maxLength={40}
              onChange={(e) => setSettings((prev) => ({ ...prev, aiName: e.target.value }))}
              onBlur={persistCurrentSettings}
              placeholder="LYKN"
              aria-label="Assistant name"
              className={cn(LG_FIELD_INLINE, LG_INLINE_W)}
            />
          }
        />
      </SettingsGroup>

      <GroupLabel>Chat</GroupLabel>
      <SettingsGroup caption="Applied to every new chat.">
        <SettingsRow
          label="Response length"
          trailing={
            <Select
              value={settings.responseLength || 'medium'}
              onValueChange={(value) => {
                const updated = { ...settings, responseLength: value };
                setSettings(updated);
                persistSettings(updated);
              }}
            >
              <SelectTrigger className={cn(LG_SELECT_INLINE, LG_INLINE_W, 'justify-between')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={LG_SELECT_CONTENT}>
                <SelectItem value="concise">Concise</SelectItem>
                <SelectItem value="medium">Balanced</SelectItem>
                <SelectItem value="detailed">Detailed</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow label="Custom instructions">
          <Textarea
            value={settings.userPrompt || ''}
            onChange={(e) => setSettings((prev) => ({ ...prev, userPrompt: e.target.value }))}
            onBlur={persistCurrentSettings}
            maxLength={1500}
            rows={4}
            placeholder="Be concise and direct. Use bullet points. Skip the preamble."
            className={cn(LG_TEXTAREA, 'mt-2')}
          />
        </SettingsRow>
      </SettingsGroup>

      <GroupLabel>Voice</GroupLabel>
      <SettingsGroup caption="Tap a voice to hear it. Voice instructions shape how the assistant sounds in live voice, not how it writes.">
        <SettingsRow label="Assistant voice">
          <div className="mt-2">
            <VoicePicker
              selectedVoiceId={settings.voiceId || ''}
              onSelect={(voiceId, voiceName) => {
                const updated = { ...settings, voiceId, voiceName: voiceName || '' };
                setSettings(updated);
                persistSettings(updated);
              }}
            />
          </div>
        </SettingsRow>
        <SettingsRow label="Voice instructions">
          <Textarea
            value={settings.voicePrompt || ''}
            onChange={(e) => setSettings((prev) => ({ ...prev, voicePrompt: e.target.value }))}
            onBlur={persistCurrentSettings}
            maxLength={1500}
            rows={4}
            placeholder="Speak warmly and casually, like a close friend. Keep replies short."
            className={cn(LG_TEXTAREA, 'mt-2')}
          />
        </SettingsRow>
      </SettingsGroup>

      <div className="flex justify-end px-1">
        <button
          type="button"
          onClick={saveAssistantSettings}
          className="rounded-[10px] bg-black px-3.5 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 dark:bg-white dark:text-black"
        >
          {assistantSaved ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  );

  const renderImport = () => (
    <div className="space-y-5">
      <SettingsGroup caption="Upload a .zip export from ChatGPT, Claude, or another assistant. LYKN will read every conversation and extract beliefs, preferences, and projects.">
        {!importFile ? (
          <label
            onDragOver={(e) => { e.preventDefault(); setIsDraggingImport(true); }}
            onDragLeave={() => setIsDraggingImport(false)}
            onDrop={handleImportDrop}
            className={`block cursor-pointer px-3.5 py-4 transition-colors ${
              isDraggingImport ? 'bg-black/[0.04] dark:bg-white/[0.06]' : ''
            }`}
          >
            <p className="text-[13px] text-black dark:text-white">Drop your .zip here or click to choose</p>
            <p className="mt-0.5 text-[11px] text-black/45 dark:text-white/40">
              ChatGPT and Claude exports supported · up to 500 MB
            </p>
            <input
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              className="hidden"
              onChange={(e) => handleImportFileSelected(e.target.files?.[0])}
            />
          </label>
        ) : (
          <SettingsRow
            label={importFile.name}
            description={`${(importFile.size / (1024 * 1024)).toFixed(2)} MB`}
            trailing={
              <button
                type="button"
                onClick={() => {
                  setImportFile(null);
                  setImportStatus('idle');
                  setImportError('');
                }}
                disabled={importStatus === 'uploading'}
                className="text-[13px] text-[#007aff] disabled:opacity-40"
              >
                Remove
              </button>
            }
          />
        )}
      </SettingsGroup>

      {importError && <p className="px-1 text-[12px] text-red-500">{importError}</p>}

      {importFile && (
        <div className="px-1">
          <button
            type="button"
            onClick={handleImportUpload}
            disabled={importStatus === 'uploading' || importStatus === 'done'}
            className="text-[13px] font-medium text-[#007aff] disabled:opacity-40"
          >
            {importStatus === 'uploading'
              ? 'Uploading…'
              : importStatus === 'done'
                ? 'Uploaded'
                : 'Start import'}
          </button>
        </div>
      )}
    </div>
  );

  const periodEndLabel = currentPeriodEnd
    ? new Date(currentPeriodEnd).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  const renderPayment = () => (
    user ? (
      <div className="space-y-5">
        <SettingsGroup caption={cancelAtPeriodEnd && periodEndLabel
          ? `Cancels on ${periodEndLabel}. You'll keep access until then.`
          : null}
        >
          <SettingsRow
            label="Current plan"
            onClick={() => setBillingTab('usage')}
            trailing={
              <span className="flex items-center text-[13px] text-black/45 dark:text-white/45">
                {planLabel(planId)}
                {chevron}
              </span>
            }
          />
          <SettingsRow
            label="Usage this month"
            description="Requests, credits, and what spent them."
            onClick={() => setBillingTab('usage')}
            trailing={chevron}
          />
        </SettingsGroup>

        <SettingsGroup caption="Credits cover anything past your plan's included usage, and they never expire.">
          <SettingsRow
            label="Top up credits"
            onClick={() => setBillingTab('topup')}
            trailing={chevron}
          />
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            label={hasActiveSubscription ? 'Change plan' : 'Upgrade plan'}
            onClick={() => setBillingTab('plans')}
            trailing={chevron}
          />
          {hasStripeCustomer && (
            <SettingsRow
              label={portalBusy ? 'Opening…' : 'Payment method & invoices'}
              onClick={handleManageSubscription}
              disabled={portalBusy}
              trailing={chevron}
            />
          )}
          {hasActiveSubscription && !cancelAtPeriodEnd && (
            <SettingsRow
              label={portalBusy ? 'Opening…' : 'Cancel subscription'}
              danger
              onClick={handleCancelSubscription}
              disabled={portalBusy}
            />
          )}
          <SettingsRow
            label="Billing FAQ"
            onClick={() => { onClose(); nav('/billing#faq'); }}
            trailing={chevron}
          />
        </SettingsGroup>

        <BillingDialog
          open={!!billingTab}
          onOpenChange={(open) => { if (!open) setBillingTab(null); }}
          initialTab={billingTab || 'usage'}
          onNavigateAway={onClose}
        />
      </div>
    ) : (
      <SettingsGroup caption="Sign in from Account to manage your subscription.">
        <SettingsRow
          label="Go to Account"
          onClick={() => setView('account')}
          trailing={chevron}
        />
      </SettingsGroup>
    )
  );

  const renderKeyboard = () => (
    <SettingsGroup caption="Shortcuts are fixed for now — remapping is not available yet.">
      {KEY_BINDINGS.map((binding) => (
        <SettingsRow
          key={binding.label}
          label={binding.label}
          description={binding.description}
          trailing={
            <span className="flex items-center gap-1">
              {binding.keys.map((key) => (
                <KeyCap key={key}>{key}</KeyCap>
              ))}
            </span>
          }
        />
      ))}
    </SettingsGroup>
  );

  const renderAdvanced = () => (
    <div className="space-y-5">
      <SettingsGroup caption="Restores the accent, typeface, density, corner radius, and accessibility toggles on this device.">
        <SettingsRow
          label="Reset appearance to defaults"
          onClick={() => {
            saveAppearance(DEFAULT_APPEARANCE);
            setView('appearance');
          }}
          trailing={chevron}
        />
      </SettingsGroup>

      <GroupLabel>Import</GroupLabel>
      {IMPORT_ENABLED ? renderImport() : (
        <SettingsGroup caption="Bring a .zip export from ChatGPT or Claude and LYKN will read every conversation to extract beliefs, preferences, and projects.">
          <SettingsRow
            label="Import chat history"
            description="ChatGPT and Claude exports"
            disabled
            trailing={
              <span className="text-[11px] text-black/35 dark:text-white/30">Soon</span>
            }
          />
        </SettingsGroup>
      )}

      <GroupLabel>Support</GroupLabel>
      <SettingsGroup caption="Need a hand? We respond to every message.">
        <SettingsRow
          href="mailto:support@lykn.ai"
          label="Email support"
          trailing={
            <span className="text-[13px] text-black/45 dark:text-white/45">support@lykn.ai</span>
          }
        />
      </SettingsGroup>
    </div>
  );

  const renderView = () => {
    switch (view) {
      case 'account': return renderAccount();
      case 'workspace': return renderWorkspace();
      case 'assistant': return renderAiPersonalization();
      case 'notifications': return renderNotifications();
      case 'privacy': return renderPrivacy();
      case 'appearance': return renderAppearance();
      case 'integrations': return renderConnections();
      case 'billing': return renderPayment();
      case 'keyboard': return renderKeyboard();
      case 'advanced': return renderAdvanced();
      default: return renderAccount();
    }
  };

  const renderShell = (content) => {
    const body = (
      <>
        <aside className="lykn-settings-sidebar flex w-[224px] shrink-0 flex-col">
          <TrafficLights
            onClose={closeWindow}
            onMinimize={minimizeWindow}
            onZoom={zoomWindow}
            drag={embedded ? titleDrag : undefined}
          />
          <div className="relative mx-2.5 mb-2.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-black/35 dark:text-white/35" />
            <input
              type="search"
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
              placeholder="Search"
              className="lg-stepper h-[28px] w-full rounded-full border-0 pl-8 pr-2.5 text-[12px] text-black outline-none dark:text-white placeholder:text-black/35 dark:placeholder:text-white/35"
            />
          </div>
          <div className="lykn-settings-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
            {showAccountCard && (
              <button
                type="button"
                data-active={view === 'account' || undefined}
                onClick={() => setView('account')}
                className="lg-nav-item mb-2 flex w-full items-center gap-2.5 rounded-[13px] px-2 py-1.5 text-left"
              >
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <span
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-medium"
                    style={{
                      background: 'var(--lykn-accent-swatch, hsl(var(--lykn-accent)))',
                      color: 'hsl(var(--lykn-accent-fg))',
                    }}
                  >
                    {user ? profileInitial : <User className="h-3.5 w-3.5" />}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-black dark:text-white">
                    {user ? profileName : 'Sign in'}
                  </span>
                  <span className="block truncate text-[11px] text-black/45 dark:text-white/40">
                    {user?.email || 'Account'}
                  </span>
                </span>
              </button>
            )}
            <div className="flex flex-col gap-0.5">
              {filteredNav.map((item) => (
                <SidebarItem
                  key={item.id}
                  item={item}
                  active={view === item.id}
                  onSelect={setView}
                />
              ))}
              {!showAccountCard && filteredNav.length === 0 && (
                <p className="px-2 py-3 text-[12px] text-black/40 dark:text-white/35">No Results</p>
              )}
            </div>
          </div>
          {user && (
            <div className="px-2.5 pb-3 pt-1">
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-[6px] text-[13.5px] text-red-600 transition-colors dark:text-red-400 hover:bg-red-500/[0.08] dark:hover:bg-red-500/[0.1]"
              >
                <LogOut className="lg-nav-icon" strokeWidth={1.9} />
                Log Out
              </button>
            </div>
          )}
        </aside>
        <section className="lykn-settings-pane flex min-w-0 flex-1 flex-col">
          {content}
        </section>
      </>
    );

    if (embedded) {
      return (
        <div className={windowClass} role="document" aria-label="Settings">
          {body}
        </div>
      );
    }

    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent hideClose className={windowClass}>
          <DialogTitle className="sr-only">Settings</DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    );
  };

  if (loading) {
    return renderShell(
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-black/15 border-t-black/70 dark:border-white/15 dark:border-t-white/70" />
      </div>,
    );
  }

  return renderShell(
    <>
      <div
        className="flex h-[68px] shrink-0 touch-none select-none items-end px-7 pb-3.5"
        {...(embedded ? titleDrag : {})}
      >
        <h2 className="text-[24px] font-semibold leading-none tracking-[-0.01em] text-black dark:text-white">
          {VIEW_TITLES[view] || 'Settings'}
        </h2>
      </div>
      <div className={cn(
        'lykn-settings-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-7 pb-7 pt-3',
        view === 'assistant' && 'scrollbar-hide',
        view === 'integrations' && 'px-5',
      )}>
        {renderView()}
      </div>
    </>,
  );
}
