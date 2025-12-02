import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Save, LogOut, User } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function SettingsModal({ isOpen, onClose }) {
  const [settings, setSettings] = useState({
    aiAnalysisAuto: false,
    theme: 'light',
    fontSize: 'medium',
    layoutDensity: 'comfortable',
    aiPersonality: 'balanced',
    aiDetailLevel: 'medium',
    aiModel: 'core'
  });
  const [user, setUser] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem('lykinsai_settings');
    if (saved) {
      setSettings(JSON.parse(saved));
    }
    
    // Apply current theme on mount
    const currentTheme = saved ? JSON.parse(saved).theme : 'light';
    document.documentElement.classList.toggle('dark', currentTheme === 'dark');

    // Load user profile
    const loadUser = async () => {
      try {
        const currentUser = await base44.auth.me();
        setUser(currentUser);
      } catch (error) {
        console.error('Error loading user:', error);
      }
    };
    
    if (isOpen) {
      loadUser();
    }
  }, [isOpen]);

  const handleSave = () => {
    localStorage.setItem('lykinsai_settings', JSON.stringify(settings));
    
    // Apply theme globally
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    
    // Apply font size
    const fontSizes = {
      small: '14px',
      medium: '16px',
      large: '18px'
    };
    document.documentElement.style.fontSize = fontSizes[settings.fontSize];
    
    // Apply layout density
    const densities = {
      compact: '0.75',
      comfortable: '1',
      spacious: '1.25'
    };
    document.documentElement.style.setProperty('--layout-density', densities[settings.layoutDensity]);
    
    onClose();
    
    // Reload to apply all changes
    window.location.reload();
  };

  const handleLogout = () => {
    base44.auth.logout();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-white dark:bg-[#171515] border-white/30 dark:border-gray-700 text-black dark:text-white max-w-md backdrop-blur-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-black dark:text-white">Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Profile Section */}
          {user && (
            <div className="p-4 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-12 h-12 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                  <User className="w-6 h-6 text-gray-600 dark:text-gray-300" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-black dark:text-white">{user.full_name}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">{user.email}</p>
                </div>
              </div>
              <Button
                onClick={handleLogout}
                variant="outline"
                className="w-full border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515] flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </Button>
            </div>
          )}



          {/* Auto AI Analysis */}
          <div className="flex items-center justify-between">
            <Label className="text-gray-900 dark:text-white">Auto AI Analysis</Label>
            <Switch
              checked={settings.aiAnalysisAuto}
              onCheckedChange={(checked) => setSettings({...settings, aiAnalysisAuto: checked})}
            />
          </div>

          {/* Theme */}
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

          {/* Font Size */}
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

          {/* Layout Density */}
          <div className="space-y-2">
            <Label className="text-gray-900 dark:text-white">Layout Density</Label>
            <Select value={settings.layoutDensity} onValueChange={(value) => setSettings({...settings, layoutDensity: value})}>
              <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="comfortable">Comfortable</SelectItem>
                <SelectItem value="spacious">Spacious</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* AI Model */}
          <div className="space-y-2">
            <Label className="text-gray-900 dark:text-white">AI Model</Label>
            <Select value={settings.aiModel} onValueChange={(value) => setSettings({...settings, aiModel: value})}>
              <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                <SelectItem value="core">Core (Default)</SelectItem>
                <SelectItem value="gpt-3.5">GPT-3.5</SelectItem>
                <SelectItem value="gpt-4">GPT-4</SelectItem>
                <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                <SelectItem value="gemini-pro">Gemini Pro</SelectItem>
                <SelectItem value="gemini-flash">Gemini Flash</SelectItem>
                <SelectItem value="claude-3-opus">Claude 3 Opus</SelectItem>
                <SelectItem value="claude-3-sonnet">Claude 3 Sonnet</SelectItem>
                <SelectItem value="claude-3-haiku">Claude 3 Haiku</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* AI Personality */}
          <div className="space-y-2">
            <Label className="text-gray-900 dark:text-white">AI Personality</Label>
            <Select value={settings.aiPersonality} onValueChange={(value) => setSettings({...settings, aiPersonality: value})}>
              <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                <SelectItem value="professional">Professional</SelectItem>
                <SelectItem value="balanced">Balanced</SelectItem>
                <SelectItem value="casual">Casual & Friendly</SelectItem>
                <SelectItem value="enthusiastic">Enthusiastic</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* AI Detail Level */}
          <div className="space-y-2">
            <Label className="text-gray-900 dark:text-white">AI Detail Level</Label>
            <Select value={settings.aiDetailLevel} onValueChange={(value) => setSettings({...settings, aiDetailLevel: value})}>
              <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                <SelectItem value="brief">Brief & Concise</SelectItem>
                <SelectItem value="medium">Medium Detail</SelectItem>
                <SelectItem value="detailed">Comprehensive</SelectItem>
              </SelectContent>
            </Select>
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