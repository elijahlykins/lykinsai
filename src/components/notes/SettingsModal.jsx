import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Save, LogOut, User, Globe, MessageSquare } from 'lucide-react';
import { useAuth } from '@/lib/SupabaseAuth';
import { supabase } from '@/lib/supabase';

export default function SettingsModal({ isOpen, onClose }) {
  const { user, loading, signInWithOAuth, signOut } = useAuth();
  const [settings, setSettings] = useState({
    aiAnalysisAuto: false,
    theme: 'light',
    fontSize: 'medium',
    layoutDensity: 'comfortable',
    aiPersonality: 'balanced',
    aiDetailLevel: 'medium',
    aiModel: 'gemini-flash-latest',
    backgroundColor: '',
    userPrompt: '',
    responseLength: 'medium',
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'signup'
  const [authError, setAuthError] = useState('');

  // Bright white base with a very subtle blue hint (glass feel)
  const DEFAULT_BG_LIGHT = '#f3f8ff';
  const DEFAULT_BG_DARK = '#0b0b0f';

  useEffect(() => {
    const loadSettings = () => {
      const saved = localStorage.getItem('lykinsai_settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setSettings(parsed);
          document.documentElement.classList.toggle('dark', parsed.theme === 'dark');
          if (parsed.backgroundColor && typeof parsed.backgroundColor === 'string') {
            document.documentElement.style.setProperty('--app-background', parsed.backgroundColor);
          } else {
            // Default Apple-like background per theme
            document.documentElement.style.setProperty('--app-background', parsed.theme === 'dark' ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT);
          }
        } catch (e) {
          console.error('Error parsing settings:', e);
        }
      } else {
        // Default Apple-like background per theme when no saved settings exist
        document.documentElement.style.setProperty('--app-background', settings.theme === 'dark' ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT);
      }
    };
    
    loadSettings();
    
    // Reload settings when modal opens (in case they changed elsewhere)
    if (isOpen) {
      loadSettings();
    }
    
    // Listen for settings changes from other components
    const handleSettingsChange = () => {
      loadSettings();
    };
    window.addEventListener('lykinsai_settings_changed', handleSettingsChange);
    
    return () => {
      window.removeEventListener('lykinsai_settings_changed', handleSettingsChange);
    };
  }, [isOpen, user]);

  const handleSave = () => {
    localStorage.setItem('lykinsai_settings', JSON.stringify(settings));
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    const fontScales = { small: '0.875', medium: '1', large: '1.125' };
    document.documentElement.style.setProperty('--font-scale', fontScales[settings.fontSize]);
    const densities = { compact: '0.75', comfortable: '1', spacious: '1.25' };
    document.documentElement.style.setProperty('--layout-density', densities[settings.layoutDensity]);
    if (settings.backgroundColor) {
      document.documentElement.style.setProperty('--app-background', settings.backgroundColor);
    } else {
      document.documentElement.style.setProperty('--app-background', settings.theme === 'dark' ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT);
    }
    
    // Trigger custom event so other components can sync (same-tab)
    window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
    // Also trigger storage event for cross-tab sync
    window.dispatchEvent(new Event('storage'));
    
    onClose();
    window.location.reload();
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
        <DialogContent className="bg-white dark:bg-[#171515] border-white/30 dark:border-gray-700 text-black dark:text-white max-w-md backdrop-blur-2xl">
          <div className="flex items-center justify-center p-8">
            <div className="w-6 h-6 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-white dark:bg-[#171515] border-white/30 dark:border-gray-700 text-black dark:text-white max-w-md backdrop-blur-2xl max-h-[90vh] overflow-y-auto">
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
                        console.error('Google OAuth error:', error);
                      }
                    } catch (error) {
                      setAuthError("Google sign-in failed. Please try again later.");
                      console.error('Google OAuth exception:', error);
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

          {/* All your other settings... */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-gray-900 dark:text-white">Auto AI Analysis</Label>
              <Switch
                checked={settings.aiAnalysisAuto}
                onCheckedChange={(checked) => setSettings({...settings, aiAnalysisAuto: checked})}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-gray-900 dark:text-white">Response Length</Label>
              <Select value={settings.responseLength || 'medium'} onValueChange={(value) => setSettings({...settings, responseLength: value})}>
                <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                  <SelectItem value="concise">Concise</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="detailed">Detailed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-gray-900 dark:text-white">Theme</Label>
              <Select value={settings.theme} onValueChange={(value) => setSettings({...settings, theme: value})}>
                <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-gray-900 dark:text-white">App Background</Label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={settings.backgroundColor || (settings.theme === 'dark' ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT)}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSettings({ ...settings, backgroundColor: value });
                    document.documentElement.style.setProperty('--app-background', value);
                  }}
                  className="h-10 w-14 rounded-xl bg-white/40 dark:bg-gray-800/40 border border-white/40 dark:border-gray-700/40 backdrop-blur-md"
                  title="Pick app background"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl"
                  onClick={() => {
                    const def = settings.theme === 'dark' ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT;
                    setSettings({ ...settings, backgroundColor: '' });
                    document.documentElement.style.setProperty('--app-background', def);
                  }}
                >
                  Reset
                </Button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Sets the global background behind all glass surfaces.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-gray-900 dark:text-white">Font Size</Label>
              <Select value={settings.fontSize} onValueChange={(value) => setSettings({...settings, fontSize: value})}>
                <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                  <SelectItem value="small">Small</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="large">Large</SelectItem>
                </SelectContent>
              </Select>
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
                <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                  <SelectItem value="gpt-5.2">GPT-5.2 (Latest)</SelectItem>
                  <SelectItem value="gpt-5.1">GPT-5.1</SelectItem>
                  <SelectItem value="gpt-5">GPT-5</SelectItem>
                  <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                  <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                  <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                  <SelectItem value="gpt-4">GPT-4</SelectItem>
                  <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                  <SelectItem value="claude-opus-4-1-20250805">Claude Opus 4.1</SelectItem>
                  <SelectItem value="claude-opus-4-20250514">Claude Opus 4</SelectItem>
                  <SelectItem value="claude-sonnet-4-20250514">Claude Sonnet 4</SelectItem>
                  <SelectItem value="claude-haiku-4-5-20251001">Claude Haiku 4.5</SelectItem>
                  <SelectItem value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Preview)</SelectItem>
                  <SelectItem value="gemini-3-pro-preview">Gemini 3 Pro (Preview)</SelectItem>
                  <SelectItem value="gemini-3-flash-preview">Gemini 3 Flash (Preview)</SelectItem>
                  <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                  <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash</SelectItem>
                  <SelectItem value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</SelectItem>
                  <SelectItem value="gemini-2.5-flash-image-preview">Gemini 2.5 Flash Image</SelectItem>
                  <SelectItem value="gemini-2.5-flash-live-preview">Gemini 2.5 Flash Live</SelectItem>
                  <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash</SelectItem>
                  <SelectItem value="gemini-2.0-flash-lite">Gemini 2.0 Flash-Lite</SelectItem>
                  <SelectItem value="grok-4-1-fast-reasoning">Grok 4.1 Fast Reasoning</SelectItem>
                  <SelectItem value="grok-4-1-fast-non-reasoning">Grok 4.1 Fast Non-Reasoning</SelectItem>
                  <SelectItem value="grok-code-fast-1">Grok Code Fast 1</SelectItem>
                  <SelectItem value="grok-4-fast-reasoning">Grok 4 Fast Reasoning</SelectItem>
                  <SelectItem value="grok-4-fast-non-reasoning">Grok 4 Fast Non-Reasoning</SelectItem>
                  <SelectItem value="grok-4-0709">Grok 4 0709</SelectItem>
                  <SelectItem value="grok-3-mini">Grok 3 Mini</SelectItem>
                  <SelectItem value="grok-3">Grok 3</SelectItem>
                  <SelectItem value="grok-2-vision-1212">Grok 2 Vision 1212</SelectItem>
                  <SelectItem value="grok-imagine-image-pro">Grok Imagine Image Pro</SelectItem>
                  <SelectItem value="grok-imagine-image">Grok Imagine Image</SelectItem>
                  <SelectItem value="grok-2-image-1212">Grok 2 Image 1212</SelectItem>
                  <SelectItem value="grok-imagine-video">Grok Imagine Video</SelectItem>
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
            className="bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}