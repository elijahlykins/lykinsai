import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Loader2, Clock } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

export default function SearchModal({ isOpen, onClose, notes, onSelectNote }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    
    setIsSearching(true);
    try {
      const notesContext = notes.map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content}\nType: ${n.storage_type}`
      ).join('\n\n---\n\n');

      const searchResults = await base44.integrations.Core.InvokeLLM({
        prompt: `Given this search query: "${query}"
        
Find the most relevant notes based on ideas, concepts, and meaning (not just keyword matching).

Available notes:
${notesContext}

Return the IDs of the most relevant notes, ranked by relevance.`,
        response_json_schema: {
          type: 'object',
          properties: {
            note_ids: { type: 'array', items: { type: 'string' } }
          }
        }
      });

      const foundNotes = notes.filter(n => searchResults.note_ids?.includes(n.id));
      setResults(foundNotes);
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectNote = (note) => {
    onSelectNote(note);
    onClose();
    setQuery('');
    setResults([]);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-dark-card border-white/10 text-white max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-white">AI Search</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search by ideas, concepts, or keywords..."
            className="flex-1 bg-dark-lighter border-white/10 text-white placeholder:text-gray-500"
          />
          <Button
            onClick={handleSearch}
            disabled={isSearching || !query.trim()}
            className="bg-white text-black hover:bg-gray-200"
          >
            {isSearching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto mt-4 space-y-2">
          {results.length > 0 ? (
            results.map((note) => (
              <button
                key={note.id}
                onClick={() => handleSelectNote(note)}
                className="w-full text-left p-4 rounded-lg bg-dark-lighter border border-white/10 hover:bg-dark hover:border-white/20 transition-all"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold text-white">{note.title}</h3>
                  <span className="text-xs text-gray-500 px-2 py-1 bg-white/5 rounded">
                    {note.storage_type === 'short_term' ? 'Short Term' : 'Long Term'}
                  </span>
                </div>
                <p className="text-sm text-gray-400 line-clamp-2 mb-2">{note.content}</p>
                <div className="flex items-center gap-1 text-xs text-gray-500">
                  <Clock className="w-3 h-3" />
                  <span>{format(new Date(note.created_date), 'MMM d, yyyy')}</span>
                </div>
              </button>
            ))
          ) : query && !isSearching ? (
            <p className="text-center text-gray-500 py-8">No results found</p>
          ) : (
            <p className="text-center text-gray-500 py-8">Search for memories by ideas or concepts</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}