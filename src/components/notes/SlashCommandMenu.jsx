import React, { useEffect, useState, useRef } from 'react';
import { Heading1, Heading2, Heading3, List, ListOrdered, Image, Quote, Code, CheckSquare, Minus } from 'lucide-react';
import { createPortal } from 'react-dom';

const COMMANDS = [
  { id: 'h1', label: 'Heading 1', icon: Heading1, description: 'Big section heading' },
  { id: 'h2', label: 'Heading 2', icon: Heading2, description: 'Medium section heading' },
  { id: 'h3', label: 'Heading 3', icon: Heading3, description: 'Small section heading' },
  { id: 'bullet', label: 'Bulleted List', icon: List, description: 'Create a simple bulleted list' },
  { id: 'ordered', label: 'Numbered List', icon: ListOrdered, description: 'Create a list with numbering' },
  { id: 'check', label: 'To-do List', icon: CheckSquare, description: 'Track tasks with a to-do list' },
  { id: 'quote', label: 'Quote', icon: Quote, description: 'Capture a quote' },
  { id: 'code', label: 'Code', icon: Code, description: 'Capture a code snippet' },
  { id: 'divider', label: 'Divider', icon: Minus, description: 'Visually divide blocks' },
  { id: 'image', label: 'Image', icon: Image, description: 'Upload an image' },
];
export default function SlashCommandMenu({ position, filter, onSelect, onClose, selectedIndex }) {
  const menuRef = useRef(null);
  
  const filteredCommands = COMMANDS.filter(cmd => 
    cmd.label.toLowerCase().includes(filter.toLowerCase()) || 
    cmd.description.toLowerCase().includes(filter.toLowerCase())
  );

  // If no commands match, don't render
  if (filteredCommands.length === 0) return null;

  // Close if clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Handle Enter key from parent
  useEffect(() => {
    const handleEnter = () => {
        if (filteredCommands[selectedIndex]) {
            onSelect(filteredCommands[selectedIndex]);
        }
    };
    document.addEventListener('slash-enter', handleEnter);
    return () => document.removeEventListener('slash-enter', handleEnter);
  }, [selectedIndex, filteredCommands, onSelect]);

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
            onClick={() => onSelect(cmd)}
            className={`w-full flex items-center gap-3 p-2 rounded-md transition-colors text-left ${
              index === selectedIndex 
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