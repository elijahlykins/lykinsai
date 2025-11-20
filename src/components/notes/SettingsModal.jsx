import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Save } from 'lucide-react';

export default function SettingsModal({ isOpen, onClose }) {
  const [settings, setSettings] = useState({
    textColor: 'black',
    autoArchiveDays: '30',
    aiAnalysisAuto: false,
    theme: 'light',
    accentColor: 'lavender',
    fontSize: 'medium',
    layoutDensity: 'comfortable',
    aiPersonality: 'balanced',
    aiDetailLevel: 'medium'
  });

  useEffect(() => {
    const saved = localStorage.getItem('lykinsai_settings');
    if (saved) {
      setSettings(JSON.parse(saved));
    }
    
    // Apply current theme on mount
    const currentTheme = saved ? JSON.parse(saved).theme : 'light';
    document.documentElement.classList.toggle('dark', currentTheme === 'dark');
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
    
    // Apply accent color
    const accentColors = {
      lavender: '#b8a4d4',
      mint: '#8dd4b8',
      blue: '#8db4d4',
      peach: '#d4b8a4'
    };
    document.documentElement.style.setProperty('--accent-color', accentColors[settings.accentColor]);
    
    onClose();
    
    // Reload to apply all changes
    window.location.reload();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-glass-card border-white/30 text-gray-900 max-w-md backdrop-blur-2xl">
        <DialogHeader>
          <DialogTitle className="text-gray-900">Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Text Color */}
          <div className="space-y-2">
            <Label className="text-gray-900">Note Text Color</Label>
            <Select value={settings.textColor} onValueChange={(value) => setSettings({...settings, textColor: value})}>
              <SelectTrigger className="bg-white/60 border-white/40 text-gray-900 backdrop-blur-md rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-glass-card border-white/30 backdrop-blur-2xl">
                <SelectItem value="white">White</SelectItem>
                <SelectItem value="black">Black</SelectItem>
                <SelectItem value="#b8a4d4">Lavender</SelectItem>
                <SelectItem value="#8dd4b8">Mint</SelectItem>
                <SelectItem value="#8db4d4">Blue</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Auto Archive Days */}
          <div className="space-y-2">
            <Label className="text-gray-900 dark:text-white">Auto-Archive After (Days)</Label>
            <Select value={settings.autoArchiveDays} onValueChange={(value) => setSettings({...settings, autoArchiveDays: value})}>
              <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                <SelectItem value="7">7 Days</SelectItem>
                <SelectItem value="14">14 Days</SelectItem>
                <SelectItem value="30">30 Days</SelectItem>
                <SelectItem value="60">60 Days</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </div>

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

          {/* Accent Color */}
          <div className="space-y-2">
            <Label className="text-gray-900 dark:text-white">Accent Color</Label>
            <Select value={settings.accentColor} onValueChange={(value) => setSettings({...settings, accentColor: value})}>
              <SelectTrigger className="bg-white/60 dark:bg-gray-800/60 border-white/40 dark:border-gray-700/40 text-gray-900 dark:text-white backdrop-blur-md rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-glass-card border-white/30 dark:border-gray-700/30 backdrop-blur-2xl">
                <SelectItem value="lavender">Lavender</SelectItem>
                <SelectItem value="mint">Mint</SelectItem>
                <SelectItem value="blue">Blue</SelectItem>
                <SelectItem value="peach">Peach</SelectItem>
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
            className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="bg-gray-900 text-white hover:bg-gray-800 dark:bg-white dark:text-black dark:hover:bg-gray-200 flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}