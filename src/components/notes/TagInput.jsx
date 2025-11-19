import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';

export default function TagInput({ tags, onChange }) {
  const [inputValue, setInputValue] = useState('');

  const handleAddTag = (e) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      if (!tags.includes(inputValue.trim())) {
        onChange([...tags, inputValue.trim()]);
      }
      setInputValue('');
    }
  };

  const handleRemoveTag = (tagToRemove) => {
    onChange(tags.filter(tag => tag !== tagToRemove));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {tags.map(tag => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-1 bg-lavender/20 text-lavender rounded-full text-xs"
          >
            {tag}
            <button
              onClick={() => handleRemoveTag(tag)}
              className="hover:bg-lavender/30 rounded-full p-0.5"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleAddTag}
          placeholder="Add tag and press Enter..."
          className="flex-1 bg-dark-lighter border-white/10 text-white text-sm"
        />
      </div>
    </div>
  );
}