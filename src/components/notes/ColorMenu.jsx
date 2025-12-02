import React, { useEffect, useRef, useState } from 'react';
import { X, RotateCcw, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';

export default function ColorMenu({ isOpen, position, onClose, currentColors, onChange, onReset, type = 'box' }) {
  const menuRef = useRef(null);
  const [savedColors, setSavedColors] = useState([]);
  
  const isText = type === 'text';
  const bgLabel = isText ? 'Highlight' : 'Background';
  const bgKey = isText ? 'background' : 'bg';
  const textKey = isText ? 'color' : 'text';
  
  // Use props directly, defaulting to white/black if undefined
  const currentColorBg = currentColors?.[bgKey] || '#ffffff';
  const currentColorText = currentColors?.[textKey] || '#000000';

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

  const handleSaveColor = async (colorToSave) => {
      if (!colorToSave) return;
      if (!savedColors.includes(colorToSave)) {
          const newColors = [...savedColors, colorToSave];
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
          {isText ? 'Text Appearance' : 'Customize Appearance'}
        </h4>
        <button onClick={onClose} className="text-gray-500 hover:text-black dark:hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-4">
          {/* Background / Highlight Section */}
          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-600 dark:text-gray-400">{bgLabel}</label>
            <div className="flex items-center gap-2">
              {/* Quick pick from saved colors */}
              {savedColors.slice(0, 3).map((c, i) => (
                  <button 
                    key={i}
                    onClick={() => onChange(bgKey, c)}
                    className="w-4 h-4 rounded-full border border-gray-300"
                    style={{ backgroundColor: c }}
                    title={c}
                  />
              ))}
              <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1"></div>
              <input
                type="color"
                value={currentColorBg === 'transparent' ? '#ffffff' : currentColorBg}
                onChange={(e) => onChange(bgKey, e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
              />
              <button 
                onClick={() => handleSaveColor(currentColorBg)}
                className="text-gray-400 hover:text-black dark:hover:text-white"
                title="Save this color"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Text Color Section */}
          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-600 dark:text-gray-400">Text</label>
            <div className="flex items-center gap-2">
               {/* Quick pick from saved colors */}
               {savedColors.slice(0, 3).map((c, i) => (
                  <button 
                    key={i}
                    onClick={() => onChange(textKey, c)}
                    className="w-4 h-4 rounded-full border border-gray-300"
                    style={{ backgroundColor: c }}
                    title={c}
                  />
              ))}
              <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1"></div>
              <input
                type="color"
                value={currentColorText}
                onChange={(e) => onChange(textKey, e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
              />
               <button 
                onClick={() => handleSaveColor(currentColorText)}
                className="text-gray-400 hover:text-black dark:hover:text-white"
                title="Save this color"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>
          
          {/* Saved Colors Management */}
          {savedColors.length > 0 && (
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
                <p className="text-[10px] text-gray-500 mb-2">Saved Colors</p>
                <div className="flex flex-wrap gap-2">
                    {savedColors.map((c, i) => (
                        <div key={i} className="group relative">
                            <button
                                onClick={() => {
                                    // Allow clicking to set as highlight (primary action usually)
                                    // Or maybe split actions? Let's just set bg as it's most common
                                    onChange(bgKey, c);
                                }}
                                className="w-6 h-6 rounded-md border border-gray-200 dark:border-gray-700 transition-transform hover:scale-110"
                                style={{ backgroundColor: c }}
                                title={c}
                            />
                            <button
                                onClick={(e) => { e.stopPropagation(); handleRemoveColor(c); }}
                                className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm z-10"
                            >
                                <X className="w-3 h-3" />
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
    </div>
  );
}