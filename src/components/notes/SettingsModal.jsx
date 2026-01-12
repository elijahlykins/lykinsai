import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Save, LogOut, User, Mail, Key, Globe, Link2, RefreshCw, X, Check } from 'lucide-react';
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
    aiModel: 'gemini-flash-latest'
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'signup'
  const [authError, setAuthError] = useState('');
  const [socialConnections, setSocialConnections] = useState([]);
  const [syncingPlatform, setSyncingPlatform] = useState(null);

  const loadSocialConnections = async () => {
    try {
      // Load from localStorage (in production, this would be from Supabase)
      const saved = localStorage.getItem('lykinsai_social_connections');
      if (saved) {
        setSocialConnections(JSON.parse(saved));
      } else {
        // Try to load from Supabase if user is authenticated
        if (user) {
          const { data, error } = await supabase
            .from('social_connections')
            .select('*')
            .eq('user_id', user.id)
            .eq('is_active', true);
          
          if (!error && data) {
            setSocialConnections(data);
            localStorage.setItem('lykinsai_social_connections', JSON.stringify(data));
          }
        }
      }
    } catch (error) {
      console.error('Error loading social connections:', error);
    }
  };

  const syncPlatformData = async (platform, accessToken) => {
    if (!accessToken) {
      const connection = socialConnections.find(c => c.platform === platform);
      if (!connection) return;
      accessToken = connection.accessToken;
    }
    
    setSyncingPlatform(platform);
    try {
      const userId = user?.id || 'anonymous';
      const { API_BASE_URL } = await import('@/lib/api-config');
      const response = await fetch(`${API_BASE_URL}/api/social/sync/${platform}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, accessToken })
      });
      
      const data = await response.json();
      
      if (data.syncedCount > 0) {
        // Update last synced time
        const updated = socialConnections.map(conn => 
          conn.platform === platform
            ? { ...conn, lastSyncedAt: new Date().toISOString() }
            : conn
        );
        setSocialConnections(updated);
        localStorage.setItem('lykinsai_social_connections', JSON.stringify(updated));
        
        // Save synced data to Supabase
        if (user && data.data) {
          for (const item of data.data) {
            await supabase.from('social_data').upsert({
              user_id: user.id,
              ...item,
              synced_at: new Date().toISOString()
            }, {
              onConflict: 'user_id,platform,platform_item_id'
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error syncing ${platform}:`, error);
    } finally {
      setSyncingPlatform(null);
    }
  };

  const handleOAuthCallback = async (connectionData) => {
    try {
      if (!connectionData || !connectionData.platform) {
        console.warn('Invalid OAuth callback data:', connectionData);
        return;
      }
      
      // Store connection locally
      const newConnection = {
        id: Date.now().toString(),
        platform: connectionData.platform,
        platformUserId: connectionData.platformUserId || '',
        platformUsername: connectionData.platformUsername || '',
        connectedAt: new Date().toISOString(),
        lastSyncedAt: null,
        accessToken: connectionData.accessToken, // In production, encrypt this
        refreshToken: connectionData.refreshToken || null
      };
      
      const updated = [...socialConnections, newConnection];
      setSocialConnections(updated);
      localStorage.setItem('lykinsai_social_connections', JSON.stringify(updated));
      
      // Also save to Supabase if user is authenticated
      if (user) {
        try {
          await supabase.from('social_connections').insert({
            user_id: user.id,
            platform: connectionData.platform,
            access_token: connectionData.accessToken,
            refresh_token: connectionData.refreshToken,
            platform_user_id: connectionData.platformUserId,
            platform_username: connectionData.platformUsername,
            token_expires_at: connectionData.expiresIn 
              ? new Date(Date.now() + connectionData.expiresIn * 1000).toISOString()
              : null
          });
        } catch (dbError) {
          console.warn('Failed to save connection to Supabase (non-critical):', dbError);
          // Don't fail the whole operation if DB save fails
        }
      }
      
      // Auto-sync data (don't await, let it run in background)
      syncPlatformData(connectionData.platform, connectionData.accessToken).catch(err => {
        console.warn('Background sync failed (non-critical):', err);
      });
    } catch (error) {
      console.error('Error handling OAuth callback:', error);
      setAuthError(`Failed to save connection: ${error.message || 'Unknown error'}`);
      // Don't throw - allow settings modal to continue working
    }
  };

  const handleConnectPlatform = async (platform) => {
    try {
      const userId = user?.id || 'anonymous';
      
      // First, test if the endpoint exists
      try {
        const { API_BASE_URL } = await import('@/lib/api-config');
        const testResponse = await fetch(`${API_BASE_URL}/api/social/test`);
        if (!testResponse.ok && testResponse.status === 404) {
          setAuthError('⚠️ Server needs restart! The social media routes are not loaded. Please:\n1. Stop your server (Ctrl+C in terminal)\n2. Restart it: npm run server\n3. Try again');
          alert('⚠️ Server Restart Required\n\nThe server is running an old version without social media routes.\n\nPlease:\n1. Go to your terminal where the server is running\n2. Press Ctrl+C to stop it\n3. Run: npm run server\n4. Try connecting again');
          return;
        }
      } catch (testError) {
        // If test endpoint fails, try the actual endpoint anyway
        console.warn('Test endpoint check failed, proceeding anyway:', testError);
      }
      
      const { API_BASE_URL } = await import('@/lib/api-config');
      const response = await fetch(`${API_BASE_URL}/api/social/connect/${platform}?userId=${userId}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          const errorMsg = '⚠️ Server Restart Required!\n\nThe social media routes are not loaded. Please restart your server:\n1. Stop server (Ctrl+C)\n2. Run: npm run server\n3. Try again';
          setAuthError(errorMsg);
          alert(errorMsg);
          return;
        }
        
        // Try to get error message from response
        let errorData;
        try {
          errorData = await response.json();
        } catch (e) {
          errorData = { error: response.statusText || 'Unknown server error' };
        }
        
        const errorMsg = errorData.error || `Server error: ${response.status}`;
        setAuthError(errorMsg);
        
        // Show helpful message for missing API keys
        if (errorMsg.includes('not configured') || errorMsg.includes('CLIENT_ID')) {
          alert(`⚠️ API Credentials Required\n\n${errorMsg}\n\nTo connect ${platform}:\n1. Get API credentials from the platform's developer portal\n2. Add them to your .env file\n3. Restart the server\n\nSee SUPABASE_SCHEMA.md for setup instructions.`);
        } else {
          alert(`Error: ${errorMsg}`);
        }
        return;
      }
      
      const data = await response.json();
      
      if (data.authUrl) {
        // Open OAuth flow in new window
        window.location.href = data.authUrl;
      } else if (data.error) {
        setAuthError(data.error);
      } else {
        setAuthError(`Failed to initiate ${platform} connection`);
      }
    } catch (error) {
      console.error(`Error connecting to ${platform}:`, error);
      if (error.message.includes('Failed to fetch') || error.message.includes('404') || error.message.includes('Unexpected token')) {
        const errorMsg = '⚠️ Server Restart Required!\n\nCannot connect to social media routes. Please:\n1. Stop your server (Ctrl+C)\n2. Restart: npm run server\n3. Try again';
        setAuthError(errorMsg);
        alert(errorMsg);
      } else {
        setAuthError(`Failed to connect to ${platform}: ${error.message}`);
      }
    }
  };

  const handleDisconnectPlatform = async (platform) => {
    try {
      const updated = socialConnections.filter(conn => conn.platform !== platform);
      setSocialConnections(updated);
      localStorage.setItem('lykinsai_social_connections', JSON.stringify(updated));
      
      // Also remove from Supabase
      if (user) {
        await supabase
          .from('social_connections')
          .update({ is_active: false })
          .eq('user_id', user.id)
          .eq('platform', platform);
      }
    } catch (error) {
      console.error('Error disconnecting platform:', error);
    }
  };

  useEffect(() => {
    const loadSettings = () => {
      const saved = localStorage.getItem('lykinsai_settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.aiModel === 'core') {
            parsed.aiModel = 'gemini-flash-latest';
          }
          setSettings(parsed);
          document.documentElement.classList.toggle('dark', parsed.theme === 'dark');
        } catch (e) {
          console.error('Error parsing settings:', e);
        }
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
    
    // Load social connections
    loadSocialConnections();
    
    // Check for OAuth callback (only for social media integrations, not Supabase auth)
    // Supabase handles its own OAuth callbacks via URL hash fragments (#access_token=...)
    // Social media integrations use query parameters (?connected=...&data=...)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const connected = urlParams.get('connected');
      const error = urlParams.get('error');
      const data = urlParams.get('data');
      const hasSupabaseHash = window.location.hash && window.location.hash.includes('access_token');
      
      // Only handle social media OAuth callbacks (Pinterest, Instagram, etc.)
      // Skip if this looks like a Supabase OAuth callback
      if (connected && data && !hasSupabaseHash) {
        try {
          const connectionData = JSON.parse(Buffer.from(data, 'base64').toString());
          // Only process if it's a social media platform, not Supabase auth
          if (connectionData.platform && ['pinterest', 'instagram'].includes(connectionData.platform)) {
            handleOAuthCallback(connectionData);
            // Clean URL
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        } catch (e) {
          console.error('Error parsing OAuth callback:', e);
          // Don't break the settings modal if callback parsing fails
        }
      } else if (error && !hasSupabaseHash) {
        // Only show error if it's not a Supabase OAuth callback
        // Check if it's a social media error (has platform context)
        if (error.includes('pinterest') || error.includes('instagram') || error.includes('social')) {
          setAuthError(`Connection failed: ${error}`);
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
    } catch (urlError) {
      // If URL parsing fails, don't break the settings modal
      console.warn('Error processing URL parameters:', urlError);
    }
    
    return () => {
      window.removeEventListener('lykinsai_settings_changed', handleSettingsChange);
    };
  }, [isOpen, user]);

  const handleSave = () => {
    localStorage.setItem('lykinsai_settings', JSON.stringify(settings));
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    const fontSizes = { small: '14px', medium: '16px', large: '18px' };
    document.documentElement.style.fontSize = fontSizes[settings.fontSize];
    const densities = { compact: '0.75', comfortable: '1', spacious: '1.25' };
    document.documentElement.style.setProperty('--layout-density', densities[settings.layoutDensity]);
    
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
      setAuthError(error.message);
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
                        setAuthError(`Google sign-in failed: ${error.message}`);
                        console.error('Google OAuth error:', error);
                      }
                    } catch (error) {
                      setAuthError(`Google sign-in error: ${error.message || 'Unknown error'}`);
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

          {/* Social Media Integrations Section */}
          <div className="p-4 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded-xl border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                <Link2 className="w-5 h-5 text-gray-600 dark:text-gray-300" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-black dark:text-white">Social Integrations</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Connect your accounts to help AI understand your interests
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {/* Pinterest */}
              <div className="flex items-center justify-between p-3 bg-white dark:bg-[#171515] rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <span className="text-red-600 dark:text-red-400 font-bold text-xs">P</span>
                  </div>
                  <div>
                    <p className="font-medium text-black dark:text-white">Pinterest</p>
                    {socialConnections.find(c => c.platform === 'pinterest') ? (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Connected as {socialConnections.find(c => c.platform === 'pinterest')?.platformUsername || 'user'}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-500 dark:text-gray-400">Not connected</p>
                    )}
                  </div>
                </div>
                {socialConnections.find(c => c.platform === 'pinterest') ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => syncPlatformData('pinterest')}
                      disabled={syncingPlatform === 'pinterest'}
                      className="h-8"
                    >
                      {syncingPlatform === 'pinterest' ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3 h-3" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDisconnectPlatform('pinterest')}
                      className="h-8 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => handleConnectPlatform('pinterest')}
                    className="h-8"
                  >
                    Connect
                  </Button>
                )}
              </div>

              {/* Instagram */}
              <div className="flex items-center justify-between p-3 bg-white dark:bg-[#171515] rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                    <span className="text-white font-bold text-xs">IG</span>
                  </div>
                  <div>
                    <p className="font-medium text-black dark:text-white">Instagram</p>
                    {socialConnections.find(c => c.platform === 'instagram') ? (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Connected as {socialConnections.find(c => c.platform === 'instagram')?.platformUsername || 'user'}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-500 dark:text-gray-400">Not connected</p>
                    )}
                  </div>
                </div>
                {socialConnections.find(c => c.platform === 'instagram') ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => syncPlatformData('instagram')}
                      disabled={syncingPlatform === 'instagram'}
                      className="h-8"
                    >
                      {syncingPlatform === 'instagram' ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3 h-3" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDisconnectPlatform('instagram')}
                      className="h-8 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => handleConnectPlatform('instagram')}
                    className="h-8"
                  >
                    Connect
                  </Button>
                )}
              </div>
            </div>

            {socialConnections.length > 0 && (
              <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                💡 Connected accounts help AI provide personalized recommendations based on your interests
              </p>
            )}
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
                  <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                  <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                  <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                  <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                  <SelectItem value="gpt-4">GPT-4</SelectItem>
                  <SelectItem value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</SelectItem>
                  <SelectItem value="claude-3-opus-20240229">Claude 3 Opus</SelectItem>
                  <SelectItem value="claude-3-sonnet-20240229">Claude 3 Sonnet</SelectItem>
                  <SelectItem value="gemini-flash-latest">Gemini Flash Latest (Free Tier)</SelectItem>
                  <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash (Free Tier)</SelectItem>
                  <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash (Free Tier)</SelectItem>
                  <SelectItem value="gemini-pro-latest">Gemini Pro Latest</SelectItem>
                  <SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                  <SelectItem value="grok-beta">Grok Beta</SelectItem>
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