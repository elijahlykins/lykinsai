import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Save, LogOut, User, Globe, MessageSquare, Sun, Moon, Monitor } from 'lucide-react';

import AboutYouSection from '@/components/intake/AboutYouSection';
import { useAuth } from '@/lib/SupabaseAuth';
import { supabase } from '@/lib/supabase';

export default function SettingsModal({ isOpen, onClose }) {
  const { user, loading, signInWithOAuth, signOut } = useAuth();
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

  const DEFAULT_BG_LIGHT = '#ffffff';
  const DEFAULT_BG_DARK = '#1e1e1e';

  const applyTheme = (theme) => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = theme === 'dark' || (theme === 'system' && prefersDark);
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.style.setProperty(
      '--app-background',
      isDark ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT
    );
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

          {/* Custom User Prompt */}
          <div className="p-4 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded-xl border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-black dark:text-white">Personal AI Instructions</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Tell the AI about yourself and how you want it to respond
                </p>
              </div>
            </div>
            <textarea
              value={settings.userPrompt || ''}
              onChange={(e) => setSettings({ ...settings, userPrompt: e.target.value })}
              placeholder="e.g. I'm a software developer. Always respond in concise bullet points. I prefer technical explanations over simplified ones."
              className="w-full h-28 px-3 py-2 text-sm bg-white dark:bg-[#171515] border border-gray-200 dark:border-gray-700 text-black dark:text-white rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-black/20 dark:focus:ring-white/20"
            />
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              This is added to every AI conversation so it knows your preferences.
            </p>
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
                setSettings({...settings, aiModel: value});
                // Save immediately so Create page can sync
                const updatedSettings = {...settings, aiModel: value};
                localStorage.setItem('lykinsai_settings', JSON.stringify(updatedSettings));
                // Trigger custom event for immediate sync (same-tab)
                window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
              }}>
                <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-glass-card border-white/15 dark:border-gray-700/20 backdrop-blur-md">
                    <SelectGroup>
                      <SelectLabel>Latest</SelectLabel>
                      <SelectItem value="claude-sonnet-4-6" hint="Anthropic flagship">Claude Sonnet 4.6</SelectItem>
                      <SelectItem value="gpt-5.4" hint="OpenAI flagship">GPT-5.4</SelectItem>
                      <SelectItem value="gemini-3.1-pro-preview" hint="Google flagship">Gemini 3.1 Pro</SelectItem>
                      <SelectItem value="grok-4-1-fast-reasoning" hint="xAI flagship">Grok 4.1 Fast Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Fastest</SelectLabel>
                      <SelectItem value="gemini-3-flash-preview" hint="Google, ultra-fast">Gemini 3 Flash</SelectItem>
                      <SelectItem value="gemini-3.1-flash-lite-preview" hint="Google, cheapest">Gemini 3.1 Flash-Lite</SelectItem>
                      <SelectItem value="gemini-2.5-flash" hint="Google, balanced">Gemini 2.5 Flash</SelectItem>
                      <SelectItem value="gpt-4.1-nano" hint="OpenAI, smallest">GPT-4.1 Nano</SelectItem>
                      <SelectItem value="gpt-4.1-mini" hint="OpenAI, fast + smart">GPT-4.1 Mini</SelectItem>
                      <SelectItem value="gpt-5-mini" hint="OpenAI, near-frontier">GPT-5 Mini</SelectItem>
                      <SelectItem value="claude-haiku-4-5-20251001" hint="Anthropic, fast">Claude Haiku 4.5</SelectItem>
                      <SelectItem value="grok-4-1-fast-non-reasoning" hint="xAI, low latency">Grok 4.1 Fast Non-Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Cheap</SelectLabel>
                      <SelectItem value="gpt-4o-mini" hint="OpenAI, budget">GPT-4o Mini</SelectItem>
                      <SelectItem value="o4-mini" hint="OpenAI, cheap reasoning">o4 Mini</SelectItem>
                      <SelectItem value="grok-3-mini" hint="xAI, budget">Grok 3 Mini</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Image Gen</SelectLabel>
                      <SelectItem value="gpt-image-1.5" hint="OpenAI, images">GPT Image 1.5</SelectItem>
                      <SelectItem value="gemini-3.1-flash-image-preview" hint="Google, images">Nano Banana 2</SelectItem>
                      <SelectItem value="grok-imagine-image-pro" hint="xAI, pro images">Grok Imagine Image Pro</SelectItem>
                      <SelectItem value="grok-imagine-image" hint="xAI, images">Grok Imagine Image</SelectItem>
                      <SelectItem value="grok-2-image-1212" hint="xAI, images">Grok 2 Image</SelectItem>
                      <SelectItem value="dall-e-3" hint="OpenAI, images">DALL-E 3</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Deep Thinking</SelectLabel>
                      <SelectItem value="o3" hint="OpenAI, reasoning">o3</SelectItem>
                      <SelectItem value="o3-pro" hint="OpenAI, max reasoning">o3 Pro</SelectItem>
                      <SelectItem value="gpt-5.4-pro" hint="OpenAI, extended">GPT-5.4 Pro</SelectItem>
                      <SelectItem value="claude-opus-4-1-20250805" hint="Anthropic, deep">Claude Opus 4.1</SelectItem>
                      <SelectItem value="claude-opus-4-20250514" hint="Anthropic, deep">Claude Opus 4</SelectItem>
                      <SelectItem value="gemini-2.5-pro" hint="Google, reasoning">Gemini 2.5 Pro</SelectItem>
                      <SelectItem value="grok-4-fast-reasoning" hint="xAI, reasoning">Grok 4 Fast Reasoning</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Code</SelectLabel>
                      <SelectItem value="claude-opus-4-6-code" hint="Anthropic, top coder">Claude Opus 4.6</SelectItem>
                      <SelectItem value="gpt-5.3-codex" hint="OpenAI, agentic code">Codex 5.3</SelectItem>
                      <SelectItem value="gpt-4.1" hint="OpenAI, 1M ctx code">GPT-4.1</SelectItem>
                      <SelectItem value="grok-code-fast-1" hint="xAI, code">Grok Code Fast 1</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>General</SelectLabel>
                      <SelectItem value="gpt-5.2" hint="OpenAI, previous gen">GPT-5.2</SelectItem>
                      <SelectItem value="gpt-5.1" hint="OpenAI, previous gen">GPT-5.1</SelectItem>
                      <SelectItem value="gpt-5" hint="OpenAI, previous gen">GPT-5</SelectItem>
                      <SelectItem value="gpt-4o" hint="OpenAI, versatile">GPT-4o</SelectItem>
                      <SelectItem value="claude-sonnet-4-20250514" hint="Anthropic, balanced">Claude Sonnet 4</SelectItem>
                      <SelectItem value="grok-4-fast-non-reasoning" hint="xAI, general">Grok 4 Fast Non-Reasoning</SelectItem>
                      <SelectItem value="grok-4-0709" hint="xAI, general">Grok 4 0709</SelectItem>
                      <SelectItem value="grok-3" hint="xAI, previous gen">Grok 3</SelectItem>
                      <SelectItem value="grok-2-vision-1212" hint="xAI, vision">Grok 2 Vision</SelectItem>
                      <SelectItem value="unified-auto" hint="Auto-picks best">Unified AI (Auto)</SelectItem>
                    </SelectGroup>
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
            className="bg-blue-500 text-white hover:bg-blue-600 flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}