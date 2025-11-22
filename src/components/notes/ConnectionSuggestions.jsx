import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Link2, Loader2, Plus, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function ConnectionSuggestions({ content, currentNoteId, allNotes, onConnect }) {
  const [suggestions, setSuggestions] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [connectedIds, setConnectedIds] = useState([]);

  useEffect(() => {
    if (content && content.length > 50) {
      analyzeSuggestions();
    } else {
      setSuggestions([]);
    }
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

      const notesContext = availableNotes.map((n, idx) => 
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
    setConnectedIds([...connectedIds, noteId]);
    onConnect(noteId);
  };

  if (!content || content.length < 50) {
    return null;
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
              <div key={note.id} className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-black text-sm mb-1">{note.title}</h4>
                    <p className="text-xs text-gray-600 mb-2">{reason}</p>
                    <p className="text-xs text-gray-500 line-clamp-1">{note.content}</p>
                  </div>
                  <Button
                    onClick={() => handleConnect(note.id)}
                    disabled={isConnected}
                    size="sm"
                    className={isConnected ? 'bg-green-600 text-white' : 'bg-black text-white hover:bg-gray-800'}
                  >
                    {isConnected ? (
                      <>
                        <Check className="w-3 h-3 mr-1" />
                        Linked
                      </>
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