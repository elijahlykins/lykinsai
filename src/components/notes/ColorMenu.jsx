import React, { useEffect, useRef, useState } from 'react';
import { X, RotateCcw, Check, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';

export default function ColorMenu({ isOpen, position, onClose, currentColors, onChange, onReset, type = 'box' }) {
  const menuRef = useRef(null);
  const [savedColors, setSavedColors] = useState([]);
  const [customColor, setCustomColor] = useState('#000000');

  useEffect(() => {
    const loadSavedColors = async () => {
        try {
            const user = await base44.auth.me();
            if (user?.saved_colors) {
                setSavedColors(user.saved_colors);
            }
        } catch (error) {
            console.error('Failed to load saved colors', error);
        }
    };
    if (isOpen) loadSavedColors();
  }, [isOpen]);

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

  const handleSaveColor = async () => {
      if (!savedColors.includes(customColor)) {
          const newColors = [...savedColors, customColor];
          setSavedColors(newColors);
          try {
              await base44.auth.updateMe({ saved_colors: newColors });
          } catch (error) {
              console.error('Failed to save color', error);
          }
      }
  };

  const handleRemoveColor = async (colorToRemove) => {
      const newColors = savedColors.filter(c => c !== colorToRemove);
      setSavedColors(newColors);
      try {
          await base44.auth.updateMe({ saved_colors: newColors });
      } catch (error) {
          console.error('Failed to remove color', error);
      }
  };

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
             {/* Saved Colors for Text */}
             {savedColors.map((c, i) => (
               <button
                 key={'saved-text-' + i}
                 onClick={() => onChange('color', c)}
                 className="w-full aspect-square rounded-lg border border-gray-200 dark:border-gray-700 hover:scale-110 transition-transform flex items-center justify-center relative group"
                 style={{ backgroundColor: c }}
                 title={c}
               >
                  <div 
                    onClick={(e) => { e.stopPropagation(); handleRemoveColor(c); }}
                    className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-2 h-2" />
                  </div>
               </button>
             ))}
           </div>
           
           <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
             <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-500 block">Highlight</label>
                <div className="flex items-center gap-1">
                    <input 
                        type="color" 
                        value={customColor} 
                        onChange={(e) => setCustomColor(e.target.value)}
                        className="w-5 h-5 rounded cursor-pointer border-0 p-0 bg-transparent"
                    />
                    <button onClick={handleSaveColor} className="text-gray-500 hover:text-black dark:hover:text-white">
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
             </div>
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
               {/* Saved Colors for Highlight */}
               {savedColors.map((c, i) => (
                 <button
                   key={'saved-bg-' + i}
                   onClick={() => onChange('background', c)}
                   className="w-full aspect-square rounded-lg border border-gray-200 dark:border-gray-700 hover:scale-110 transition-transform flex items-center justify-center relative group"
                   style={{ backgroundColor: c }}
                   title={c}
                 >
                    <div 
                        onClick={(e) => { e.stopPropagation(); handleRemoveColor(c); }}
                        className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                        <X className="w-2 h-2" />
                    </div>
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
              {/* Quick pick from saved colors */}
              {savedColors.slice(0, 3).map((c, i) => (
                  <button 
                    key={i}
                    onClick={() => onChange('bg', c)}
                    className="w-4 h-4 rounded-full border border-gray-300"
                    style={{ backgroundColor: c }}
                  />
              ))}
              <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1"></div>
              <input
                type="color"
                value={currentColors?.bg || '#ffffff'}
                onChange={(e) => onChange('bg', e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
              />
              <button 
                onClick={() => {
                    const color = currentColors?.bg || '#ffffff';
                    if(!savedColors.includes(color)) {
                        handleSaveColor(); // Saves customColor state, wait we need to pass the color
                        // Let's fix handleSaveColor to accept an arg or update state before calling
                        const newColors = [...savedColors, color];
                        setSavedColors(newColors);
                        base44.auth.updateMe({ saved_colors: newColors });
                    }
                }}
                className="text-gray-400 hover:text-black dark:hover:text-white"
                title="Save this color"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-600 dark:text-gray-400">Text</label>
            <div className="flex items-center gap-2">
               {/* Quick pick from saved colors */}
               {savedColors.slice(0, 3).map((c, i) => (
                  <button 
                    key={i}
                    onClick={() => onChange('text', c)}
                    className="w-4 h-4 rounded-full border border-gray-300"
                    style={{ backgroundColor: c }}
                  />
              ))}
              <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1"></div>
              <input
                type="color"
                value={currentColors?.text || '#000000'}
                onChange={(e) => onChange('text', e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
              />
            </div>
          </div>
          
          {savedColors.length > 0 && (
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
                <p className="text-[10px] text-gray-500 mb-2">Saved Colors</p>
                <div className="flex flex-wrap gap-2">
                    {savedColors.map((c, i) => (
                        <div key={i} className="group relative">
                            <button
                                onClick={() => {
                                    // If user clicks saved color, what do we apply it to?
                                    // Probably background by default or let them pick above
                                    // But for "Saved Colors" section, maybe copy to clipboard or something?
                                    // Let's just let them pick in the inputs above. 
                                    // This section is mainly for management (delete)
                                }}
                                className="w-6 h-6 rounded-md border border-gray-200 dark:border-gray-700"
                                style={{ backgroundColor: c }}
                            />
                            <button
                                onClick={(e) => { e.stopPropagation(); handleRemoveColor(c); }}
                                className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                <X className="w-2 h-2" />
                            </button>
                        </div>
                    ))}
                </div>
            </div>
          )}

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