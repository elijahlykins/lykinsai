import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Link2, Loader2, Plus, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function ConnectionSuggestions({ content, currentNoteId, allNotes, onConnect, onViewNote, compact = false }) {
  const [suggestions, setSuggestions] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [connectedIds, setConnectedIds] = useState([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (content && content.length > 50) {
        analyzeSuggestions();
      } else {
        setSuggestions([]);
      }
    }, 3000); // Debounce for 3 seconds

    return () => clearTimeout(timer);
  }, [content]);

  const analyzeSuggestions = async () => {
    setIsAnalyzing(true);
    try {
      const availableNotes = allNotes.filter(n => n.id !== currentNoteId);
      if (availableNotes.length === 0) {
        setSuggestions([]);
        setIsAnalyzing(false);
        return;
      }

      // Limit context to top 20 recent notes to prevent rate limits
      const notesContext = availableNotes.slice(0, 20).map((n, idx) => 
        `[${idx}] ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content.substring(0, 200)}`
      ).join('\n\n');

      const result = await base44.integrations.Core.InvokeLLM({
        prompt: `Analyze this note content and suggest which existing notes (by ID) have conceptual similarities or could form meaningful connections.

Current note content: "${content}"

Existing notes:
${notesContext}

Return up to 5 note IDs that are most relevant, along with a brief reason for each connection. Only suggest notes with strong conceptual links.`,
        response_json_schema: {
          type: 'object',
          properties: {
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  note_id: { type: 'string' },
                  reason: { type: 'string' }
                }
              }
            }
          }
        }
      });

      const suggestedNotes = (result.suggestions || [])
        .map(s => ({
          note: availableNotes.find(n => n.id === s.note_id),
          reason: s.reason
        }))
        .filter(s => s.note);

      setSuggestions(suggestedNotes);
    } catch (error) {
      console.error('Error analyzing suggestions:', error);
      setSuggestions([]);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleConnect = (noteId) => {
    if (connectedIds.includes(noteId)) {
      setConnectedIds(connectedIds.filter(id => id !== noteId));
    } else {
      setConnectedIds([...connectedIds, noteId]);
      onConnect(noteId);
    }
  };

  if (!content || content.length < 50) {
    return null;
  }

  if (compact) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <Link2 className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-black dark:text-white">Related Memories</h3>
        </div>
        
        {suggestions.length > 0 ? (
          <div className="space-y-2">
            {suggestions.slice(0, 3).map(({ note, reason }) => {
              const isConnected = connectedIds.includes(note.id);
              return (
                <div key={note.id} className="group relative">
                  <button
                    onClick={() => onViewNote?.(note)}
                    className="w-full p-3 bg-white/50 dark:bg-black/20 rounded-xl hover:bg-white dark:hover:bg-black/40 transition-all text-left"
                  >
                    <h4 className="font-medium text-black dark:text-white text-xs mb-1">{note.title}</h4>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight line-clamp-2">{reason}</p>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleConnect(note.id); }}
                    className={`absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center transition-all ${isConnected ? 'bg-green-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-500 opacity-0 group-hover:opacity-100'}`}
                  >
                    {isConnected ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                  </button>
                </div>
              );
            })}
          </div>
        ) : isAnalyzing ? (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Scanning memories...</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="clay-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-black dark:text-white" />
          <h3 className="font-semibold text-black dark:text-white">Suggested Connections</h3>
        </div>
        {isAnalyzing && <Loader2 className="w-4 h-4 animate-spin text-gray-600 dark:text-gray-400" />}
      </div>

      {suggestions.length > 0 ? (
        <div className="space-y-2">
          {suggestions.map(({ note, reason }) => {
            const isConnected = connectedIds.includes(note.id);
            return (
              <div key={note.id} className="p-3 bg-gray-50 dark:bg-[#1f1d1d] rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-start justify-between gap-3">
                  <button
                    onClick={() => onViewNote?.(note)}
                    className="flex-1 min-w-0 text-left hover:opacity-70 transition-opacity"
                  >
                    <h4 className="font-medium text-black dark:text-white text-sm mb-1">{note.title}</h4>
                    <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">{reason}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-500 line-clamp-1">{note.content}</p>
                  </button>
                  <Button
                    onClick={() => handleConnect(note.id)}
                    size="sm"
                    className={isConnected ? 'bg-green-600 hover:bg-green-700 text-white w-8 h-8 p-0' : 'bg-black dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200'}
                  >
                    {isConnected ? (
                      <Check className="w-4 h-4 text-white" />
                    ) : (
                      <>
                        <Plus className="w-3 h-3 mr-1" />
                        Link
                      </>
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : !isAnalyzing && (
        <p className="text-sm text-gray-500 text-center py-4">
          No similar notes found
        </p>
      )}
    </div>
  );
}