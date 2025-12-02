import React, { useEffect, useRef } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ColorMenu({ isOpen, position, onClose, currentColors, onChange, onReset }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div 
      ref={menuRef}
      style={{ 
        position: 'fixed', 
        top: position.y, 
        left: position.x,
        zIndex: 100 
      }}
      className="bg-white dark:bg-[#1f1d1d] rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-4 w-64 animate-in zoom-in-95 duration-100"
    >
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-semibold text-black dark:text-white">Customize Appearance</h4>
        <button onClick={onClose} className="text-gray-500 hover:text-black dark:hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-xs text-gray-600 dark:text-gray-400">Background Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={currentColors?.bg || '#ffffff'}
              onChange={(e) => onChange('bg', e.target.value)}
              className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
            />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <label className="text-xs text-gray-600 dark:text-gray-400">Text Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={currentColors?.text || '#000000'}
              onChange={(e) => onChange('text', e.target.value)}
              className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
            />
          </div>
        </div>

        <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
            <Button 
                onClick={() => {
                    onReset();
                    onClose();
                }}
                variant="ghost" 
                className="w-full h-8 text-xs flex items-center justify-center gap-2 text-gray-500 hover:text-black dark:hover:text-white"
            >
                <RotateCcw className="w-3 h-3" />
                Reset to Default
            </Button>
        </div>
      </div>
    </div>
  );
}