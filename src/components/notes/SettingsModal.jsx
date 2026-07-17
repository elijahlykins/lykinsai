import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  LogOut,
  User,
  Shield,
  Monitor,
  CreditCard,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Globe,
  Sparkles,
  Upload,
  FileArchive,
  Plug,
  X,
  Loader2,
  Check,
  Mail,
  ExternalLink,
  MessageCircle,
  AudioLines,
  Pencil,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import ConnectionsAppGrid from '@/components/connections/ConnectionsAppGrid';
import ModelSelectOptions from '@/components/ModelSelectOptions';
import VoicePicker from '@/components/notes/VoicePicker';
import { useAuth } from '@/lib/SupabaseAuth';
import { supabase } from '@/lib/supabase';
import { toast } from '@/components/ui/use-toast';
import { useNavigate } from 'react-router-dom';
import { useUserPlan } from '@/lib/useUserPlan';
import { isModelAllowedForPlan, canonicalizeModelId, defaultModelForTier } from '@/lib/modelTiers';
import { planLabel } from '@/lib/pricing-config';
import { API_BASE_URL } from '@/lib/api-config';
import { parseNightShiftTier } from '@/lib/stewardQueue';
import { applyTheme, normalizeTheme, readSavedTheme } from '@/lib/theme';

// ---------------------------------------------------------------------
// MenuRow — single icon + title row in the main settings list.
// Hover is intentionally very light (bg-black/[0.03] / white/[0.04]).
// ---------------------------------------------------------------------
function MenuRow({ icon: Icon, title, onClick, danger = false, trailing = null, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left transition-colors
        ${disabled
          ? 'text-black/45 dark:text-white/45 cursor-default'
          : danger
            ? 'text-red-600 dark:text-red-400 hover:bg-red-500/[0.06] dark:hover:bg-red-500/[0.08]'
            : 'text-black dark:text-white hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'}`}
    >
      <Icon className={`w-4 h-4 shrink-0 ${danger ? '' : 'text-gray-500 dark:text-gray-400'}`} />
      <span className="flex-1 text-sm font-medium">{title}</span>
      {trailing ?? (
        !danger && <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-500" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------
// SubViewHeader — back button + title for any settings sub-page.
// ---------------------------------------------------------------------
function SubViewHeader({ title, onBack }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 p-1.5 rounded-md text-gray-600 dark:text-gray-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
        aria-label="Back to settings"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <h3 className="text-sm font-semibold text-black dark:text-white">{title}</h3>
    </div>
  );
}

export default function SettingsModal({ isOpen, onClose }) {
  const { user, loading, signInWithOAuth, signOut } = useAuth();
  const { planId, modelTier, hasStripeCustomer } = useUserPlan();
  const nav = useNavigate();
  const location = useLocation();
  const [portalBusy, setPortalBusy] = useState(false);

  // 'menu' | 'account' | 'privacy' | 'display' | 'aiPersonalization' | 'import'
  // | 'payment' | 'help' | 'connections'
  const [view, setView] = useState('menu');

  // ---- AI personalization: explicit save feedback ----
  const [aiPersonalizationSaveStatus, setAiPersonalizationSaveStatus] = useState('idle'); // idle | saved

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

  // Reset to menu whenever the modal closes/reopens.
  useEffect(() => {
    if (!isOpen) setView('menu');
  }, [isOpen]);

  // The AI Personalization "Saved" confirmation persists for the whole visit and
  // only resets to "Save" once the user leaves that view (or closes the modal).
  useEffect(() => {
    if (view !== 'aiPersonalization') setAiPersonalizationSaveStatus('idle');
  }, [view]);

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
    if (isOpen && view === 'privacy' && user?.id) void loadNightShiftPref();
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
    if (wantsConnections) setView('connections');
  }, [isOpen, location.hash, location.search]);

  const handleManageSubscription = useCallback(async () => {
    if (portalBusy) return;
    setPortalBusy(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/billing/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        title: 'Billing portal unavailable',
        description: err?.message || 'Could not open the billing portal.',
      });
      setPortalBusy(false);
    }
  }, [portalBusy]);

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
  });

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
    localStorage.setItem('lykinsai_settings', JSON.stringify(normalized));
    const densities = { compact: '0.75', comfortable: '1', spacious: '1.25' };
    document.documentElement.style.setProperty('--layout-density', densities[normalized.layoutDensity]);
    applyTheme(normalized.theme);
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

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (authMode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
      }
      setEmail('');
      setPassword('');
    } catch {
      setAuthError('Sign-in failed. Please check your email and password.');
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

  if (loading) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="bg-white dark:bg-[#1e1e1e] border-white/15 dark:border-gray-700 text-black dark:text-white max-w-md backdrop-blur-md">
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <div className="flex items-center justify-center p-8">
            <div className="w-6 h-6 border-4 border-slate-200 border-t-slate-800 dark:border-white/15 dark:border-t-white/70 rounded-full animate-spin" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ===========================================================
  // MAIN MENU
  // ===========================================================
  const renderMenu = () => (
    <div className="py-2">
      {user && (
        <div className="px-3 pb-3 mb-1 border-b border-black/[0.06] dark:border-white/[0.06]">
          <p className="text-xs text-gray-500 dark:text-gray-400">Signed in as</p>
          <p className="text-sm font-medium text-black dark:text-white truncate">{user.email}</p>
        </div>
      )}
      <div className="flex flex-col">
        <MenuRow icon={User} title="Account" onClick={() => setView('account')} />
        <MenuRow icon={Plug} title="Connections" onClick={() => setView('connections')} />
        <MenuRow icon={Shield} title="Privacy" onClick={() => setView('privacy')} />
        <MenuRow icon={Monitor} title="Display" onClick={() => setView('display')} />
        <MenuRow icon={Sparkles} title="AI Personalization" onClick={() => setView('aiPersonalization')} />
        {/* The chat-history import backend (/api/import/chat-history) hasn't
            shipped yet — every upload 404'd after the user picked a file.
            Keep the row visible but inert until the server route exists. */}
        <MenuRow
          icon={Upload}
          title="Import"
          disabled
          onClick={() => {}}
          trailing={
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              Coming soon
            </span>
          }
        />
        <MenuRow icon={CreditCard} title="Payment" onClick={() => setView('payment')} />
        <MenuRow icon={HelpCircle} title="Help" onClick={() => setView('help')} />
        {user && (
          <MenuRow
            icon={LogOut}
            title="Logout"
            onClick={handleLogout}
            danger
            trailing={<span />}
          />
        )}
      </div>
    </div>
  );

  // ===========================================================
  // ACCOUNT
  // ===========================================================
  const renderAccount = () => (
    <div>
      <SubViewHeader title="Account" onBack={() => setView('menu')} />
      {user ? (
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label className="text-xs text-gray-600 dark:text-gray-400">Email</Label>
            <p className="text-sm text-black dark:text-white">{user.email}</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-gray-600 dark:text-gray-400">Display name</Label>
            <div className="flex gap-2">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="flex-1 px-3 py-2 text-sm bg-white dark:bg-[#1f1d1d] border border-gray-200 dark:border-gray-700 text-black dark:text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-black/20 dark:focus:ring-white/20"
              />
              <Button
                onClick={handleSaveDisplayName}
                disabled={displayNameStatus === 'saving' || displayName.trim() === initialDisplayName.trim()}
                variant="outline"
                className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] min-w-[80px]"
              >
                {displayNameStatus === 'saving' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : displayNameStatus === 'saved' ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </div>

          <div className="pt-4 mt-4 border-t border-black/[0.06] dark:border-white/[0.06] space-y-2">
            <Label className="text-xs text-gray-600 dark:text-gray-400">Security</Label>
            <Button
              type="button"
              onClick={handleSignOutEverywhere}
              disabled={signOutEverywhereBusy}
              variant="outline"
              className="w-full !bg-transparent border-red-300 dark:border-red-900/60 text-red-600 dark:text-red-400 !shadow-none hover:!bg-red-500/[0.06] dark:hover:!bg-red-500/[0.08] hover:text-red-700 dark:hover:text-red-300 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {signOutEverywhereBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogOut className="w-4 h-4" />
              )}
              {signOutEverywhereBusy ? 'Signing out everywhere…' : 'Sign out of all devices'}
            </Button>
            <p className="text-[11px] text-gray-500 dark:text-gray-500 leading-snug">
              Revokes every active session on your account. Use this if you suspect someone else has access.
            </p>
          </div>

        </div>
      ) : (
        <div className="space-y-3">
          <Button
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
            variant="outline"
            className="w-full border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] flex items-center justify-center gap-2"
          >
            <Globe className="w-4 h-4" />
            Google
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200 dark:border-gray-700" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white dark:bg-[#1e1e1e] px-2 text-gray-500 dark:text-gray-400">Or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleAuth} className="space-y-3">
            {authError && <p className="text-sm text-red-500">{authError}</p>}
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-white dark:bg-[#1f1d1d] border border-gray-300 dark:border-gray-600 text-black dark:text-white rounded"
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-white dark:bg-[#1f1d1d] border border-gray-300 dark:border-gray-600 text-black dark:text-white rounded"
              required
            />
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
                variant="outline"
                className="flex-1 border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]"
              >
                {authMode === 'login' ? 'Sign Up' : 'Sign In'}
              </Button>
              <Button
                type="submit"
                className="flex-1 bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
              >
                {authMode === 'login' ? 'Sign In' : 'Create Account'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );

  // ===========================================================
  // CONNECTIONS — the three connect cards (API / MCP / Build), formerly
  // the standalone /connections page. ConnectionsAppGrid runs in
  // `embedded` mode so its picker renders inline instead of as a fixed
  // overlay (a `fixed` child of Radix's transformed DialogContent would
  // anchor to the dialog, not the viewport).
  // ===========================================================
  const renderConnections = () => (
    <div>
      <ConnectionsAppGrid user={user} embedded onBack={() => setView('menu')} />
    </div>
  );

  // ===========================================================
  // PRIVACY
  // ===========================================================
  const renderPrivacy = () => (
    <div>
      <SubViewHeader title="Privacy" onBack={() => setView('menu')} />
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Review LYKN&apos;s privacy commitments.
        </p>

        {user && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-black dark:text-white">Night Shift</p>
                <p className="text-xs text-gray-500 dark:text-gray-500 mt-0.5">
                  Work on your projects overnight and leave a morning brief.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={nightShiftEnabled}
                disabled={nightShiftLoading || nightShiftSaving}
                onClick={() => void toggleNightShift()}
                className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
                  nightShiftEnabled
                    ? 'bg-sky-500 border-sky-500'
                    : 'bg-gray-200 dark:bg-gray-700 border-gray-300 dark:border-gray-600'
                } ${nightShiftLoading || nightShiftSaving ? 'opacity-60 cursor-wait' : ''}`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-0.5 ${
                    nightShiftEnabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            {nightShiftEnabled ? (
              <div className="flex rounded-lg border border-gray-200 dark:border-gray-700/60 overflow-hidden">
                {[
                  { tier: 'brief', label: 'Brief' },
                  { tier: 'research', label: 'Research' },
                  { tier: 'delegate', label: 'Delegate' },
                ].map(({ tier, label }, i) => (
                  <button
                    key={tier}
                    type="button"
                    disabled={nightShiftSaving}
                    onClick={() => void setNightShiftTierPref(tier)}
                    className={`flex-1 px-2 py-1.5 text-xs transition-colors ${
                      i > 0 ? 'border-l border-gray-200 dark:border-gray-700/60' : ''
                    } ${
                      nightShiftTier === tier
                        ? 'bg-black/[0.05] dark:bg-white/[0.08] font-medium text-black dark:text-white'
                        : 'text-gray-500 dark:text-gray-400 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}

        <div className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-700/60 overflow-hidden">
          {[
            { to: '/privacy', label: 'Privacy Policy' },
            { to: '/cookies', label: 'Cookie Policy' },
            { to: '/dpa', label: 'Data Processing Addendum' },
            { to: '/terms', label: 'Terms of Service' },
          ].map((row, i, arr) => (
            <Link
              key={row.to}
              to={row.to}
              onClick={onClose}
              className={`flex items-center justify-between px-3 py-2.5 text-sm text-black dark:text-white hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors ${
                i < arr.length - 1 ? 'border-b border-gray-200 dark:border-gray-700/60' : ''
              }`}
            >
              <span>{row.label}</span>
              <ExternalLink className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );

  // ===========================================================
  // DISPLAY
  // ===========================================================
  const renderDisplay = () => (
    <div>
      <SubViewHeader title="Display" onBack={() => setView('menu')} />
      <div className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
            <Monitor className="w-3 h-3" />
            Theme
          </Label>
          <Select
            value={settings.theme || 'dark'}
            onValueChange={(value) => {
              const updated = { ...settings, theme: value };
              setSettings(updated);
              persistSettings(updated);
            }}
          >
            <SelectTrigger className="h-auto border-0 bg-transparent shadow-none rounded-none px-1 py-1 text-sm font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors focus:ring-0 focus:ring-offset-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-white dark:bg-[#1a1818] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl backdrop-blur-xl p-1">
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  // ===========================================================
  // AI PERSONALIZATION
  // ===========================================================
  const renderAiPersonalization = () => (
    <div>
      <SubViewHeader title="AI Personalization" onBack={() => setView('menu')} />
      <div className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
            <Sparkles className="w-3 h-3" />
            Default AI model
          </Label>
          <Select
            value={settings.aiModel}
            onValueChange={(value) => {
              if (!isModelAllowedForPlan(value, modelTier)) return;
              const updated = { ...settings, aiModel: value };
              setSettings(updated);
              persistSettings(updated);
            }}
          >
            <SelectTrigger className="h-auto border-0 bg-transparent shadow-none rounded-none px-1 py-1 text-sm font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors focus:ring-0 focus:ring-offset-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-white dark:bg-[#1a1818] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl backdrop-blur-xl p-1">
              <ModelSelectOptions modelTier={modelTier} />
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2 pt-2 border-t border-gray-200 dark:border-gray-700/60">
          <Label className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-1.5 pt-2">
            <Pencil className="w-3 h-3" />
            Assistant name
          </Label>
          <p className="text-[11px] text-gray-500 dark:text-gray-500 leading-relaxed">
            Give your assistant its own name. It will refer to itself by this name in chat and voice instead of &ldquo;LYKN&rdquo;.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={settings.aiName || ''}
              maxLength={40}
              onChange={(e) => setSettings((prev) => ({ ...prev, aiName: e.target.value }))}
              onBlur={persistCurrentSettings}
              placeholder="LYKN"
              className="flex-1 px-3 py-2 text-sm bg-white dark:bg-[#1f1d1d] border border-gray-200 dark:border-gray-700 text-black dark:text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-black/20 dark:focus:ring-white/20"
            />
          </div>
        </div>

        {/* ── Chat preferences ── */}
        <div className="space-y-4 pt-3 border-t border-gray-200 dark:border-gray-700/60">
          <p className="text-xs font-semibold text-black dark:text-white flex items-center gap-1.5">
            <MessageCircle className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
            Chat
          </p>

          <div className="space-y-2">
            <Label className="text-xs text-gray-600 dark:text-gray-400">
              Custom instructions
            </Label>
            <p className="text-[11px] text-gray-500 dark:text-gray-500 leading-relaxed">
              Tell your assistant how to respond in chat: tone, format, the overall feel, things to always or never do. Applied to every chat.
            </p>
            <Textarea
              value={settings.userPrompt || ''}
              onChange={(e) => setSettings((prev) => ({ ...prev, userPrompt: e.target.value }))}
              onBlur={persistCurrentSettings}
              maxLength={1500}
              rows={4}
              placeholder="e.g. Be concise and direct. Use bullet points. Skip the preamble."
              className="resize-none text-sm bg-black/[0.02] dark:bg-white/[0.04] border-gray-200 dark:border-white/10"
            />
            <div className="text-right text-[10px] text-gray-400 dark:text-gray-600">
              {(settings.userPrompt || '').length}/1500
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-gray-600 dark:text-gray-400">
              Response length
            </Label>
            <Select
              value={settings.responseLength || 'medium'}
              onValueChange={(value) => {
                const updated = { ...settings, responseLength: value };
                setSettings(updated);
                persistSettings(updated);
              }}
            >
              <SelectTrigger className="h-auto border-0 bg-transparent shadow-none rounded-none px-1 py-1 text-sm font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors focus:ring-0 focus:ring-offset-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-white dark:bg-[#1a1818] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl backdrop-blur-xl p-1">
                <SelectItem value="concise">Concise</SelectItem>
                <SelectItem value="medium">Balanced</SelectItem>
                <SelectItem value="detailed">Detailed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* ── Voice preferences ── */}
        <div className="space-y-2 pt-3 border-t border-gray-200 dark:border-gray-700/60">
          <p className="text-xs font-semibold text-black dark:text-white flex items-center gap-1.5">
            <AudioLines className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
            Voice
          </p>

          <div className="space-y-2">
            <Label className="text-xs text-gray-600 dark:text-gray-400">
              Assistant voice
            </Label>
            <p className="text-[11px] text-gray-500 dark:text-gray-500 leading-relaxed">
              Pick the voice your assistant speaks with in voice conversations. Tap a voice to preview it, then select your favorite.
            </p>
            <VoicePicker
              selectedVoiceId={settings.voiceId || ''}
              onSelect={(voiceId, voiceName) => {
                const updated = { ...settings, voiceId, voiceName: voiceName || '' };
                setSettings(updated);
                persistSettings(updated);
              }}
            />
          </div>

          <Label className="text-xs text-gray-600 dark:text-gray-400 pt-1">
            Voice instructions
          </Label>
          <p className="text-[11px] text-gray-500 dark:text-gray-500 leading-relaxed">
            How you want your assistant to sound and behave in live voice conversations: pace, warmth, formality, the overall feel.
          </p>
          <Textarea
            value={settings.voicePrompt || ''}
            onChange={(e) => setSettings((prev) => ({ ...prev, voicePrompt: e.target.value }))}
            onBlur={persistCurrentSettings}
            maxLength={1500}
            rows={4}
            placeholder="e.g. Speak warmly and casually, like a close friend. Keep replies short. Don't over-explain."
            className="resize-none text-sm bg-black/[0.02] dark:bg-white/[0.04] border-gray-200 dark:border-white/10"
          />
          <div className="text-right text-[10px] text-gray-400 dark:text-gray-600">
            {(settings.voicePrompt || '').length}/1500
          </div>
        </div>

        <div className="pt-4 mt-1 border-t border-gray-200 dark:border-gray-700/60">
          <Button
            onClick={() => {
              persistCurrentSettings();
              setAiPersonalizationSaveStatus('saved');
            }}
            className="w-full bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 flex items-center justify-center gap-2"
          >
            {aiPersonalizationSaveStatus === 'saved' ? (
              <>
                <Check className="w-4 h-4" />
                Saved
              </>
            ) : (
              'Save'
            )}
          </Button>
        </div>
      </div>
    </div>
  );

  // ===========================================================
  // IMPORT — upload a chat-history .zip from ChatGPT / Claude / etc.
  // ===========================================================
  const renderImport = () => (
    <div>
      <SubViewHeader title="Import" onBack={() => setView('menu')} />
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Upload a <code className="px-1 py-0.5 text-xs bg-black/5 dark:bg-white/10 rounded">.zip</code> export from ChatGPT, Claude, or another assistant. LYKN will read every conversation and extract beliefs, preferences, and projects.
        </p>

        {!importFile ? (
          <label
            onDragOver={(e) => { e.preventDefault(); setIsDraggingImport(true); }}
            onDragLeave={() => setIsDraggingImport(false)}
            onDrop={handleImportDrop}
            className={`flex flex-col items-center justify-center px-4 py-8 rounded-xl border-2 border-dashed cursor-pointer transition-colors
              ${isDraggingImport
                ? 'border-black/40 dark:border-white/40 bg-black/[0.03] dark:bg-white/[0.04]'
                : 'border-gray-300 dark:border-gray-700 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]'}`}
          >
            <Upload className="w-5 h-5 text-gray-400 dark:text-gray-500 mb-2" />
            <p className="text-sm text-black dark:text-white">
              Drop your <span className="font-medium">.zip</span> here or click to choose
            </p>
            <p className="text-[11px] text-gray-500 dark:text-gray-500 mt-1">
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
          <div className="flex items-center gap-3 px-3 py-3 rounded-lg border border-gray-200 dark:border-gray-700/60 bg-white/40 dark:bg-white/[0.02]">
            <FileArchive className="w-5 h-5 text-gray-500 dark:text-gray-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-black dark:text-white truncate">{importFile.name}</p>
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                {(importFile.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setImportFile(null);
                setImportStatus('idle');
                setImportError('');
              }}
              disabled={importStatus === 'uploading'}
              className="p-1 rounded-md text-gray-400 hover:text-black dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40"
              aria-label="Remove file"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {importError && <p className="text-xs text-red-500">{importError}</p>}

        {importFile && (
          <Button
            onClick={handleImportUpload}
            disabled={importStatus === 'uploading' || importStatus === 'done'}
            className="w-full bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 flex items-center justify-center gap-2"
          >
            {importStatus === 'uploading' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Uploading…
              </>
            ) : importStatus === 'done' ? (
              <>
                <Check className="w-4 h-4" />
                Uploaded
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Start import
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );

  // ===========================================================
  // PAYMENT
  // ===========================================================
  const renderPayment = () => (
    <div>
      <SubViewHeader title="Payment" onBack={() => setView('menu')} />
      {user ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700/60 p-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">Current plan</p>
            <p className="text-sm font-medium text-black dark:text-white">{planLabel(planId)}</p>
          </div>

          <div className="flex flex-col">
            {hasStripeCustomer ? (
              <button
                type="button"
                onClick={handleManageSubscription}
                disabled={portalBusy}
                className="w-full text-left px-1 py-2 text-sm font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors disabled:opacity-50"
              >
                {portalBusy ? 'Opening…' : 'Manage subscription'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { onClose(); nav('/billing'); }}
                className="w-full text-left px-1 py-2 text-sm font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors"
              >
                Upgrade plan
              </button>
            )}
            <button
              type="button"
              onClick={() => { onClose(); nav('/billing'); }}
              className="w-full text-left px-1 py-2 text-sm font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors"
            >
              {hasStripeCustomer ? 'Change plan' : 'View plans'}
            </button>
            <button
              type="button"
              onClick={() => { onClose(); nav('/billing#faq'); }}
              className="w-full text-left px-1 py-2 text-sm font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors"
            >
              Billing FAQ
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Sign in from the Account screen to manage your subscription.
        </p>
      )}
    </div>
  );

  // ===========================================================
  // HELP
  // ===========================================================
  const renderHelp = () => (
    <div>
      <SubViewHeader title="Help" onBack={() => setView('menu')} />
      <div className="space-y-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Need a hand? We respond to every message.
        </p>
        <a
          href="mailto:support@lykn.ai"
          className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700/60 text-sm text-black dark:text-white hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
        >
          <span className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            Email support
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">support@lykn.ai</span>
        </a>
      </div>
    </div>
  );

  const renderView = () => {
    switch (view) {
      case 'account': return renderAccount();
      case 'connections': return renderConnections();
      case 'privacy': return renderPrivacy();
      case 'display': return renderDisplay();
      case 'aiPersonalization': return renderAiPersonalization();
      case 'import':  return renderImport();
      case 'payment': return renderPayment();
      case 'help':    return renderHelp();
      default:        return renderMenu();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        // flex column with an inner scroll area (not a scrolling DialogContent)
        // so the "Settings" header and the ✕ stay pinned while long views
        // (AI Personalization, Connections) scroll underneath.
        className={`bg-white dark:bg-[#1e1e1e] border-white/15 dark:border-gray-700 text-black dark:text-white backdrop-blur-md max-h-[90vh] flex flex-col overflow-hidden ${
          view === 'connections' ? 'max-w-2xl' : 'max-w-md'
        }`}
      >
        <DialogHeader>
          <DialogTitle className="text-black dark:text-white">Settings</DialogTitle>
        </DialogHeader>

        <div className="min-w-0 py-2 flex-1 overflow-y-auto overflow-x-hidden">
          {renderView()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
