import React, { useEffect, useRef } from 'react';
import { X, RotateCcw, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ColorMenu({ isOpen, position, onClose, currentColors, onChange, onReset, type = 'box' }) {
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

  const colors = [
    { name: 'Default', value: 'transparent', text: 'inherit' },
    { name: 'Red', value: '#fee2e2', text: '#991b1b' },
    { name: 'Yellow', value: '#fef9c3', text: '#854d0e' },
    { name: 'Green', value: '#dcfce7', text: '#166534' },
    { name: 'Blue', value: '#dbeafe', text: '#1e40af' },
    { name: 'Purple', value: '#f3e8ff', text: '#6b21a8' },
    { name: 'Pink', value: '#fce7f3', text: '#9d174d' },
    { name: 'Gray', value: '#f3f4f6', text: '#374151' },
  ];

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
        <h4 className="text-sm font-semibold text-black dark:text-white">
          {type === 'text' ? 'Text Color' : 'Customize Appearance'}
        </h4>
        <button onClick={onClose} className="text-gray-500 hover:text-black dark:hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {type === 'text' ? (
        <div className="space-y-4">
           <div className="grid grid-cols-4 gap-2">
             {colors.map(c => (
               <button
                 key={c.name}
                 onClick={() => onChange('color', c.text === 'inherit' ? false : c.text)}
                 className="w-full aspect-square rounded-lg border border-gray-200 dark:border-gray-700 hover:scale-110 transition-transform flex items-center justify-center"
                 style={{ backgroundColor: c.text === 'inherit' ? 'transparent' : c.text }}
                 title={c.name}
               >
                 {c.text === 'inherit' && <RotateCcw className="w-3 h-3 text-black dark:text-white" />}
               </button>
             ))}
           </div>
           <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
             <label className="text-xs text-gray-500 mb-2 block">Highlight</label>
             <div className="grid grid-cols-4 gap-2">
               {colors.map(c => (
                 <button
                   key={c.name + 'bg'}
                   onClick={() => onChange('background', c.value === 'transparent' ? false : c.value)}
                   className="w-full aspect-square rounded-lg border border-gray-200 dark:border-gray-700 hover:scale-110 transition-transform flex items-center justify-center"
                   style={{ backgroundColor: c.value }}
                   title={c.name}
                 >
                   {c.value === 'transparent' && <RotateCcw className="w-3 h-3 text-black dark:text-white" />}
                 </button>
               ))}
             </div>
           </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-600 dark:text-gray-400">Background</label>
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
            <label className="text-xs text-gray-600 dark:text-gray-400">Text</label>
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
      )}
    </div>
  );
}