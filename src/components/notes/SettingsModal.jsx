import React, { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Save, LogOut, User, Globe, MessageSquare, Sun, Moon, Monitor, Lock, Sparkles, CreditCard } from 'lucide-react';

import AboutYouSection from '@/components/intake/AboutYouSection';
import ModelSelectOptions from '@/components/ModelSelectOptions';
import { useAuth } from '@/lib/SupabaseAuth';
import { supabase } from '@/lib/supabase';
import { useNavigate } from 'react-router-dom';
import { useUserPlan } from '@/lib/useUserPlan';
import { isModelAllowedForPlan } from '@/lib/modelTiers';
import { planMeets } from '@/components/PlanGate';
import { API_BASE_URL } from '@/lib/api-config';

export default function SettingsModal({ isOpen, onClose }) {
  const { user, loading, signInWithOAuth, signOut } = useAuth();
  const { planId, modelTier, hasStripeCustomer } = useUserPlan();
  const nav = useNavigate();
  const [portalBusy, setPortalBusy] = useState(false);

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
      alert(err?.message || 'Could not open the billing portal.');
      setPortalBusy(false);
    }
  }, [portalBusy]);
  // Custom AI instructions are a Studio-tier feature. Free / guest users see
  // the textarea disabled with an upgrade CTA instead.
  const canUseCustomPrompt = planMeets(planId, "studio");
  const [settings, setSettings] = useState({
    theme: 'dark',
    layoutDensity: 'comfortable',
    aiPersonality: 'balanced',
    aiDetailLevel: 'medium',
    aiModel: 'claude-sonnet-4-6',
    userPrompt: '',
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'signup'
  const [authError, setAuthError] = useState('');

  const DEFAULT_BG_DARK = '#1e1e1e';

  // Mirrors the bootstrap logic in `main.jsx`: while no Supabase auth
  // session exists in localStorage, the visitor is in the LYKN
  // walkthrough (landing → synthesis → vault → grid) which is
  // strictly dark mode. Once they sign in, their saved theme
  // preference wins.
  const hasAuthSessionInStorage = () => {
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && /^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)) {
          return true;
        }
      }
    } catch {
      // localStorage access may throw in private mode; treat as no session.
    }
    return false;
  };

  const applyTheme = (theme) => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effectiveTheme = hasAuthSessionInStorage() ? theme : 'dark';
    const isDark = effectiveTheme === 'dark' || (effectiveTheme === 'system' && prefersDark);
    document.documentElement.classList.toggle('dark', isDark);
    if (isDark) {
      document.documentElement.style.setProperty('--app-background', DEFAULT_BG_DARK);
    } else {
      // Let the stylesheet's beige --app-background (hsl(var(--background))) apply.
      document.documentElement.style.removeProperty('--app-background');
    }
  };

  useEffect(() => {
    const loadSettings = () => {
      const saved = localStorage.getItem('lykinsai_settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (!parsed.theme) parsed.theme = 'dark';
          setSettings(parsed);
          applyTheme(parsed.theme);
        } catch (e) {
          if (import.meta.env.DEV) console.error('Error parsing settings:', e);
        }
      }
    };
    
    loadSettings();
    if (isOpen) loadSettings();
    
    const handleSettingsChange = () => loadSettings();
    window.addEventListener('lykinsai_settings_changed', handleSettingsChange);
    
    return () => {
      window.removeEventListener('lykinsai_settings_changed', handleSettingsChange);
    };
  }, [isOpen, user]);

  const handleSave = () => {
    localStorage.setItem('lykinsai_settings', JSON.stringify(settings));
    const densities = { compact: '0.75', comfortable: '1', spacious: '1.25' };
    document.documentElement.style.setProperty('--layout-density', densities[settings.layoutDensity]);
    applyTheme(settings.theme);
    
    window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
    window.dispatchEvent(new Event('storage'));
    
    onClose();
  };

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
    } catch (error) {
      setAuthError("Sign-in failed. Please check your email and password.");
    }
  };

  if (loading) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="bg-white dark:bg-[#171515] border-white/15 dark:border-gray-700 text-black dark:text-white max-w-md backdrop-blur-md">
          <div className="flex items-center justify-center p-8">
            <div className="w-6 h-6 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-white dark:bg-[#171515] border-white/15 dark:border-gray-700 text-black dark:text-white max-w-md backdrop-blur-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-black dark:text-white">Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Authentication Section */}
          <div className="p-4 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded-xl border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                <User className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              </div>
              <div className="flex-1">
                {user ? (
                  <>
                    <p className="font-semibold text-black dark:text-white">{user.email}</p>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Signed in</p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold text-black dark:text-white">Guest User</p>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Anonymous access</p>
                  </>
                )}
              </div>
            </div>

            {user ? (
              <Button
                onClick={signOut}
                variant="outline"
                className="w-full border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </Button>
            ) : (
              <div className="space-y-3">
                <Button
                  onClick={async () => {
                    try {
                      setAuthError('');
                      const { error } = await signInWithOAuth('google');
                      if (error) {
                        setAuthError("Google sign-in failed. Please try again.");
                        if (import.meta.env.DEV) console.error('Google OAuth error:', error);
                      }
                    } catch (error) {
                      setAuthError("Google sign-in failed. Please try again later.");
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
                    <div className="w-full border-t border-gray-200 dark:border-gray-700"></div>
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-white dark:bg-[#171515] px-2 text-gray-500 dark:text-gray-400">Or continue with email</span>
                  </div>
                </div>

                <form onSubmit={handleAuth} className="space-y-3">
                  {authError && (
                    <p className="text-sm text-red-500">{authError}</p>
                  )}
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

          {/* Subscription — lets paid users open the Stripe portal directly
              without navigating to /billing first. Free signed-in users get
              an Upgrade CTA. */}
          {user && (
            <div className="p-4 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                  <CreditCard className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-black dark:text-white">
                    Subscription
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                    {planId === "free"
                      ? "You're on Free"
                      : planId === "studio"
                        ? "You're on Studio"
                        : planId === "studio_pro"
                          ? "You're on Studio Pro"
                          : planId === "studio_max"
                            ? "You're on Studio Max"
                            : `Plan: ${planId}`}
                  </p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                {hasStripeCustomer ? (
                  <Button
                    onClick={handleManageSubscription}
                    disabled={portalBusy}
                    variant="outline"
                    className="flex-1 border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] flex items-center justify-center gap-2"
                  >
                    <CreditCard className="w-4 h-4" />
                    {portalBusy ? "Opening…" : "Manage subscription"}
                  </Button>
                ) : (
                  <Button
                    onClick={() => { onClose(); nav("/billing"); }}
                    className="flex-1 bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 flex items-center justify-center gap-2"
                  >
                    <Sparkles className="w-4 h-4" />
                    Upgrade plan
                  </Button>
                )}
                <Button
                  onClick={() => { onClose(); nav("/billing"); }}
                  variant="outline"
                  className="flex-1 border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]"
                >
                  {hasStripeCustomer ? "Change plan" : "View plans"}
                </Button>
              </div>
            </div>
          )}

          {/* Custom User Prompt (Studio+) */}
          <div className="p-4 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded-xl border border-gray-200 dark:border-gray-700 relative">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-black dark:text-white flex items-center gap-1.5">
                  Personal AI Instructions
                  {!canUseCustomPrompt && <Lock className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" aria-label="Studio-only feature" />}
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {canUseCustomPrompt
                    ? "Tell the AI about yourself and how you want it to respond"
                    : "Customize how the AI responds to you — available on Studio and above."}
                </p>
              </div>
            </div>
            <textarea
              value={settings.userPrompt || ''}
              onChange={(e) => { if (canUseCustomPrompt) setSettings({ ...settings, userPrompt: e.target.value }); }}
              readOnly={!canUseCustomPrompt}
              placeholder={canUseCustomPrompt
                ? "e.g. I'm a software developer. Always respond in concise bullet points. I prefer technical explanations over simplified ones."
                : "Upgrade to Studio to personalize every AI response."}
              className={`w-full h-28 px-3 py-2 text-sm bg-white dark:bg-[#171515] border border-gray-200 dark:border-gray-700 text-black dark:text-white rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-black/20 dark:focus:ring-white/20 ${!canUseCustomPrompt ? 'opacity-60 cursor-not-allowed' : ''}`}
            />
            {canUseCustomPrompt ? (
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                This is added to every AI conversation so it knows your preferences.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => { onClose(); nav("/billing"); }}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
              >
                <Sparkles className="w-3 h-3" />
                Upgrade to Studio
              </button>
            )}
          </div>

          {user ? <AboutYouSection isOpen={isOpen} /> : null}

          {/* Settings */}
          <div className="space-y-3">
            <div className="space-y-2">
              <Label className="text-gray-900 dark:text-white">Appearance</Label>
              <div className="flex gap-2">
                {[
                  { value: 'light', icon: Sun, label: 'Light' },
                  { value: 'dark', icon: Moon, label: 'Dark' },
                  { value: 'system', icon: Monitor, label: 'System' },
                ].map(({ value, icon: Icon, label }) => (
                  <button
                    key={value}
                    onClick={() => {
                      const updated = { ...settings, theme: value };
                      setSettings(updated);
                      applyTheme(value);
                    }}
                    className={`flex-1 flex flex-col items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      settings.theme === value
                        ? 'bg-black/10 dark:bg-white/15 border border-black/20 dark:border-white/25 text-black dark:text-white shadow-sm'
                        : 'bg-white/40 dark:bg-white/5 border border-transparent text-gray-500 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-white/10'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-gray-900 dark:text-white">AI Model</Label>
              <Select value={settings.aiModel} onValueChange={(value) => {
                // Block locked selections so the stored preference never holds
                // a model the plan can't run. The top-level model picker
                // already surfaces a toast on locked clicks.
                if (!isModelAllowedForPlan(value, modelTier)) return;
                setSettings({...settings, aiModel: value});
                const updatedSettings = {...settings, aiModel: value};
                localStorage.setItem('lykinsai_settings', JSON.stringify(updatedSettings));
                window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
              }}>
                <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-glass-card border-white/15 dark:border-gray-700/20 backdrop-blur-md">
                  <ModelSelectOptions modelTier={modelTier} />
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-white/10 dark:border-gray-700/30">
          <Button
            onClick={onClose}
            variant="ghost"
            className="text-black hover:text-black dark:text-white dark:hover:text-white"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="bg-blue-500/15 dark:bg-blue-500/20 text-blue-500 dark:text-blue-400 hover:bg-blue-500/25 dark:hover:bg-blue-500/30 border-transparent shadow-none flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}