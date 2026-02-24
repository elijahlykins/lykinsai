import React, { useEffect, useState, useRef } from 'react';
import { List, ListOrdered, Image, Code, CheckSquare, Table, PenTool, Type, Video, FileText } from 'lucide-react';
import { createPortal } from 'react-dom';

const COMMANDS = [
  { id: 'text', label: 'Text', icon: Type, description: 'Continue writing' },
  { id: 'todo', label: 'Todo', icon: CheckSquare, description: 'Convert current line to a todo item' },
  { id: 'bulleted', label: 'Bulleted', icon: List, description: 'Start a bulleted list on this line' },
  { id: 'numbered', label: 'Numbered', icon: ListOrdered, description: 'Start a numbered list on this line' },
  { id: 'code', label: 'Code', icon: Code, description: 'Insert a code block' },
  { id: 'sheet', label: 'Sheet', icon: FileText, description: 'Insert a doc-style sheet (like Google Docs)' },
  { id: 'table', label: 'Table', icon: Table, description: 'Insert a spreadsheet block' },
  { id: 'image', label: 'Image', icon: Image, description: 'Upload an image' },
  { id: 'video', label: 'Video', icon: Video, description: 'Upload a video' },
  { id: 'design', label: 'Design', icon: PenTool, description: 'Insert a design board' },
];
export default function SlashCommandMenu({ position, filter, onSelect, onClose, selectedIndex }) {
  const menuRef = useRef(null);
  
  const filteredCommands = COMMANDS.filter(cmd => {
    const filterLower = filter.toLowerCase();
    const labelLower = cmd.label.toLowerCase();
    const descLower = cmd.description.toLowerCase();
    // Support /logo alias for design
    if (cmd.id === 'design' && (filterLower === 'logo' || filterLower === 'design')) return true;
    return labelLower.includes(filterLower) || descLower.includes(filterLower);
  });

  // If no commands match, don't render
  if (filteredCommands.length === 0) return null;
  
  // Parent can increment selectedIndex without clamping; keep it in-bounds here.
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, filteredCommands.length - 1));

  // Close if clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    // Use pointerdown in capture so we reliably detect outside presses across devices.
    document.addEventListener('pointerdown', handleClickOutside, true);
    return () => document.removeEventListener('pointerdown', handleClickOutside, true);
  }, [onClose]);

  // Handle Enter key from parent
  useEffect(() => {
    const handleEnter = () => {
        if (filteredCommands[safeSelectedIndex]) {
            onSelect(filteredCommands[safeSelectedIndex]);
        }
    };
    document.addEventListener('slash-enter', handleEnter);
    return () => document.removeEventListener('slash-enter', handleEnter);
  }, [safeSelectedIndex, filteredCommands, onSelect]);

  return createPortal(
    <div 
      ref={menuRef}
      style={{ 
        top: position.top + 24, // Offset slightly below cursor
        left: position.left,
        zIndex: 9999 
      }}
      className="fixed w-72 bg-white dark:bg-[#1f1d1d] rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100"
    >
      <div className="p-2 bg-gray-50 dark:bg-[#1f1d1d] border-b border-gray-100 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500 uppercase">Basic blocks</span>
      </div>
      <div className="max-h-[300px] overflow-y-auto p-1 custom-scrollbar">
        {filteredCommands.map((cmd, index) => (
          <button
            key={cmd.id}
            onPointerDown={(e) => {
              // Fire on pointer down so editor blur/unmount doesn't swallow the click.
              e.preventDefault();
              e.stopPropagation();
              onSelect(cmd);
            }}
            className={`w-full flex items-center gap-3 p-2 rounded-md transition-colors text-left ${
              index === safeSelectedIndex
                ? 'bg-gray-100 dark:bg-gray-800' 
                : 'hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            <div className="w-10 h-10 flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#2a2828]">
              <cmd.icon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </div>
            <div>
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{cmd.label}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">{cmd.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}