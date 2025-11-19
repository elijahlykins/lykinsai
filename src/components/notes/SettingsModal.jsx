import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Save } from 'lucide-react';

export default function SettingsModal({ isOpen, onClose }) {
  const [settings, setSettings] = useState({
    textColor: 'white',
    autoArchiveDays: '30',
    aiAnalysisAuto: false,
    theme: 'dark',
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
  }, [isOpen]);

  const handleSave = () => {
    localStorage.setItem('lykinsai_settings', JSON.stringify(settings));
    
    // Apply theme globally
    document.documentElement.style.setProperty('--note-text-color', settings.textColor);
    document.documentElement.style.setProperty('--accent-color', settings.accentColor);
    document.documentElement.style.setProperty('--font-size', settings.fontSize === 'small' ? '14px' : settings.fontSize === 'large' ? '18px' : '16px');
    document.documentElement.className = `theme-${settings.theme} density-${settings.layoutDensity}`;
    
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-dark-card border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white">Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Text Color */}
          <div className="space-y-2">
            <Label className="text-white">Note Text Color</Label>
            <Select value={settings.textColor} onValueChange={(value) => setSettings({...settings, textColor: value})}>
              <SelectTrigger className="bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
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
            <Label className="text-white">Auto-Archive After (Days)</Label>
            <Select value={settings.autoArchiveDays} onValueChange={(value) => setSettings({...settings, autoArchiveDays: value})}>
              <SelectTrigger className="bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
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
            <Label className="text-white">Auto AI Analysis</Label>
            <Switch
              checked={settings.aiAnalysisAuto}
              onCheckedChange={(checked) => setSettings({...settings, aiAnalysisAuto: checked})}
            />
          </div>

          {/* Theme */}
          <div className="space-y-2">
            <Label className="text-white">Theme</Label>
            <Select value={settings.theme} onValueChange={(value) => setSettings({...settings, theme: value})}>
              <SelectTrigger className="bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light (Coming Soon)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Accent Color */}
          <div className="space-y-2">
            <Label className="text-white">Accent Color</Label>
            <Select value={settings.accentColor} onValueChange={(value) => setSettings({...settings, accentColor: value})}>
              <SelectTrigger className="bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
                <SelectItem value="lavender">Lavender</SelectItem>
                <SelectItem value="mint">Mint</SelectItem>
                <SelectItem value="blue">Blue</SelectItem>
                <SelectItem value="peach">Peach</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Font Size */}
          <div className="space-y-2">
            <Label className="text-white">Font Size</Label>
            <Select value={settings.fontSize} onValueChange={(value) => setSettings({...settings, fontSize: value})}>
              <SelectTrigger className="bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
                <SelectItem value="small">Small</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="large">Large</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Layout Density */}
          <div className="space-y-2">
            <Label className="text-white">Layout Density</Label>
            <Select value={settings.layoutDensity} onValueChange={(value) => setSettings({...settings, layoutDensity: value})}>
              <SelectTrigger className="bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="comfortable">Comfortable</SelectItem>
                <SelectItem value="spacious">Spacious</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* AI Personality */}
          <div className="space-y-2">
            <Label className="text-white">AI Personality</Label>
            <Select value={settings.aiPersonality} onValueChange={(value) => setSettings({...settings, aiPersonality: value})}>
              <SelectTrigger className="bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
                <SelectItem value="professional">Professional</SelectItem>
                <SelectItem value="balanced">Balanced</SelectItem>
                <SelectItem value="casual">Casual & Friendly</SelectItem>
                <SelectItem value="enthusiastic">Enthusiastic</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* AI Detail Level */}
          <div className="space-y-2">
            <Label className="text-white">AI Detail Level</Label>
            <Select value={settings.aiDetailLevel} onValueChange={(value) => setSettings({...settings, aiDetailLevel: value})}>
              <SelectTrigger className="bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
                <SelectItem value="brief">Brief & Concise</SelectItem>
                <SelectItem value="medium">Medium Detail</SelectItem>
                <SelectItem value="detailed">Comprehensive</SelectItem>
              </SelectContent>
            </Select>
          </div>
          </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-white/10">
          <Button
            onClick={onClose}
            variant="ghost"
            className="text-gray-400 hover:text-white"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="bg-white text-black hover:bg-gray-200 flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}