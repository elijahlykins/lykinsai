import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Link2, Search } from 'lucide-react';

export default function NoteLinkSelector({ isOpen, onClose, notes, currentNoteId, selectedNoteIds, onToggleNote }) {
  const [searchQuery, setSearchQuery] = useState('');

  const availableNotes = notes.filter(note => note.id !== currentNoteId);
  const filteredNotes = availableNotes.filter(note => 
    note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    note.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-dark-card border-white/10 text-white max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Link2 className="w-5 h-5" />
            Link Notes
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes to link..."
              className="pl-10 bg-dark-lighter border-white/10 text-white"
            />
          </div>

          <div className="max-h-[50vh] overflow-auto space-y-2">
            {filteredNotes.map(note => {
              const isLinked = selectedNoteIds.includes(note.id);
              return (
                <button
                  key={note.id}
                  onClick={() => onToggleNote(note.id)}
                  className={`w-full text-left p-3 rounded-lg transition-all ${
                    isLinked 
                      ? 'bg-lavender/20 border-2 border-lavender/50' 
                      : 'bg-dark-lighter hover:bg-white/5 border-2 border-transparent'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-white truncate">{note.title}</h4>
                      <p className="text-xs text-gray-400 line-clamp-2 mt-1">{note.content}</p>
                      {note.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {note.tags.map(tag => (
                            <span key={tag} className="text-xs px-1.5 py-0.5 bg-white/5 rounded text-gray-400">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {isLinked && (
                      <div className="flex-shrink-0 w-5 h-5 rounded-full bg-lavender flex items-center justify-center">
                        <span className="text-dark text-xs">✓</span>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
            {filteredNotes.length === 0 && (
              <p className="text-center text-gray-500 py-8">No notes found</p>
            )}
          </div>

          <div className="flex justify-between items-center pt-4 border-t border-white/10">
            <p className="text-sm text-gray-400">
              {selectedNoteIds.length} note{selectedNoteIds.length !== 1 ? 's' : ''} linked
            </p>
            <Button
              onClick={onClose}
              className="bg-white text-black hover:bg-gray-200"
            >
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}