import React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sparkles, Clock, Archive, RotateCcw } from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';

export default function NoteSidebar({ notes, selectedNote, onSelectNote, onUpdate }) {
  const colorClasses = {
    lavender: 'bg-lavender/10 border-lavender/20',
    mint: 'bg-mint/10 border-mint/20',
    blue: 'bg-blue/10 border-blue/20',
    peach: 'bg-peach/10 border-peach/20'
  };

  const moveToLongTerm = async (note, e) => {
    e.stopPropagation();
    await base44.entities.Note.update(note.id, { storage_type: 'long_term' });
    onUpdate();
  };

  const moveToShortTerm = async (note, e) => {
    e.stopPropagation();
    await base44.entities.Note.update(note.id, { storage_type: 'short_term' });
    onUpdate();
  };

  const shortTermNotes = notes.filter(note => note.storage_type === 'short_term');
  const longTermNotes = notes.filter(note => note.storage_type === 'long_term');

  return (
    <div className="h-full flex flex-col clay-card p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="clay-icon-small p-2">
          <Sparkles className="w-4 h-4 text-lavender" />
        </div>
        <h2 className="text-xl font-semibold text-white">Your Memories</h2>
      </div>

      <ScrollArea className="flex-1 -mr-4 pr-4">
        <div className="space-y-6">
          {/* Short Term Section */}
          <div>
            <h3 className="text-sm font-semibold text-mint mb-3 px-2">SHORT TERM</h3>
            <div className="space-y-3">
              {shortTermNotes.length === 0 ? (
                <p className="text-xs text-gray-500 px-2">No recent memories</p>
              ) : (
                shortTermNotes.map((note) => (
                  <div key={note.id} className="relative group">
                    <button
                      onClick={() => onSelectNote(note)}
                      className={`w-full text-left p-4 rounded-2xl border-2 transition-all duration-300 clay-card-mini ${
                        colorClasses[note.color || 'lavender']
                      } ${
                        selectedNote?.id === note.id
                          ? 'ring-2 ring-white/30 scale-[1.02]'
                          : 'hover:scale-[1.01]'
                      }`}
                    >
                      <h3 className="font-semibold text-white mb-1 line-clamp-1">
                        {note.title || 'Untitled'}
                      </h3>
                      <p className="text-sm text-gray-400 line-clamp-2 mb-2">
                        {note.content}
                      </p>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1 text-xs text-gray-500">
                          <Clock className="w-3 h-3" />
                          <span>{format(new Date(note.created_date), 'MMM d, h:mm a')}</span>
                        </div>
                        <Button
                          onClick={(e) => moveToLongTerm(note, e)}
                          size="icon"
                          variant="ghost"
                          className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6"
                          title="Move to Long Term"
                        >
                          <Archive className="w-3 h-3 text-gray-400" />
                        </Button>
                      </div>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Long Term Section */}
          <div>
            <h3 className="text-sm font-semibold text-blue mb-3 px-2">LONG TERM</h3>
            <div className="space-y-3">
              {longTermNotes.length === 0 ? (
                <p className="text-xs text-gray-500 px-2">No archived memories</p>
              ) : (
                longTermNotes.map((note) => (
                  <div key={note.id} className="relative group">
                    <button
                      onClick={() => onSelectNote(note)}
                      className={`w-full text-left p-4 rounded-2xl border-2 transition-all duration-300 clay-card-mini ${
                        colorClasses[note.color || 'lavender']
                      } ${
                        selectedNote?.id === note.id
                          ? 'ring-2 ring-white/30 scale-[1.02]'
                          : 'hover:scale-[1.01]'
                      }`}
                    >
                      <h3 className="font-semibold text-white mb-1 line-clamp-1">
                        {note.title || 'Untitled'}
                      </h3>
                      <p className="text-sm text-gray-400 line-clamp-2 mb-2">
                        {note.content}
                      </p>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1 text-xs text-gray-500">
                          <Clock className="w-3 h-3" />
                          <span>{format(new Date(note.created_date), 'MMM d, h:mm a')}</span>
                        </div>
                        <Button
                          onClick={(e) => moveToShortTerm(note, e)}
                          size="icon"
                          variant="ghost"
                          className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6"
                          title="Recall to Short Term"
                        >
                          <RotateCcw className="w-3 h-3 text-gray-400" />
                        </Button>
                      </div>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {notes.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              <Sparkles className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No memories yet</p>
              <p className="text-sm mt-1">Create your first note</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}