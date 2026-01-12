import React, { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Loader2, ArrowRight } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function AISearchOverlay({ isOpen, onClose, onNavigate, allNotes = [] }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const searchTimeoutRef = useRef(null);

  // Generate suggestions based on recent notes (using your AI proxy)
  useEffect(() => {
    if (isOpen && allNotes.length > 0 && suggestions.length === 0) {
      const generateSuggestions = async () => {
        try {
          const recentNotes = allNotes.slice(0, 10).map(n => n.title).join(', ');
          const prompt = `Based on these recent note titles: "${recentNotes}", suggest 3 short, relevant search queries the user might want to make to find related information. Return ONLY a JSON object: {"queries": ["query1", "query2", "query3"]}`;

          const { API_BASE_URL } = await import('@/lib/api-config');
          const response = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt })
          });

          if (!response.ok) throw new Error('AI request failed');
          const { response: aiText } = await response.json();

          let queries = [];
          try {
            const result = JSON.parse(aiText);
            queries = result.queries || [];
          } catch (e) {
            // Fallback: extract array from raw text
            const match = aiText.match(/\[([^\]]+)\]/);
            if (match) {
              try {
                queries = JSON.parse(`[${match[1]}]`);
              } catch {}
            }
          }
          setSuggestions(queries);
        } catch (e) {
          console.error('Suggestion generation error:', e);
        }
      };
      generateSuggestions();
    }
  }, [isOpen, allNotes]);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setIsSearching(true);
    setResults(null);

    try {
      const notesContext = allNotes.slice(0, 30).map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content?.substring(0, 300) || ''}\nTags: ${n.tags?.join(', ') || ''}`
      ).join('\n\n---\n\n');

      const prompt = `You are a semantic search engine. 
        
Query: "${query}"

Documents (Notes):
${notesContext}

Find the most relevant notes that match the query conceptually or specifically.
Return ONLY a JSON object with a "results" array containing objects with "id", "relevance_score" (0-100), and "reason" (short explanation).
Return at most 5 results.`;

      const { API_BASE_URL } = await import('@/lib/api-config');
      const response = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt })
      });

      if (!response.ok) throw new Error('Search AI failed');
      const { response: aiText } = await response.json();

      let aiResults = [];
      try {
        const parsed = JSON.parse(aiText);
        aiResults = parsed.results || [];
      } catch (e) {
        // Fallback: try to extract results from raw text (less reliable)
        console.warn('Failed to parse AI search response as JSON');
      }

      const enrichedResults = aiResults
        .map(r => {
          const note = allNotes.find(n => n.id === r.id);
          return note ? { ...note, ...r } : null;
        })
        .filter(r => r)
        .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

      setResults(enrichedResults);
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl bg-white/95 dark:bg-[#171515]/95 backdrop-blur-xl border-white/20 dark:border-gray-700/50 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center gap-2">
            <Search className="w-6 h-6" />
            AI Search
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-6 py-4">
          <div className="relative">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search by concept, idea, or keyword..."
              className="h-14 text-lg pl-4 pr-12 rounded-2xl bg-white dark:bg-[#1f1d1d] border-2 border-gray-100 dark:border-gray-700 focus:border-blue-500/50 focus:ring-0"
            />
            <Button
              onClick={handleSearch}
              disabled={isSearching || !query.trim()}
              className="absolute right-2 top-2 bottom-2 rounded-xl w-10 h-10 p-0"
            >
              {isSearching ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
            </Button>
          </div>

          {!results && !isSearching && suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  onClick={() => { setQuery(s); handleSearch(); }}
                  className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-full text-sm hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {results && (
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-3">
                {results.length > 0 ? (
                  results.map((result) => (
                    <button
                      key={result.id}
                      onClick={() => {
                        onNavigate?.(result);
                        onClose();
                      }}
                      className="w-full p-4 bg-white dark:bg-[#1f1d1d] rounded-xl border border-gray-100 dark:border-gray-700 hover:border-blue-400/50 text-left transition-all group"
                    >
                      <div className="flex justify-between items-start mb-1">
                        <h3 className="font-semibold text-lg group-hover:text-blue-500 transition-colors">{result.title}</h3>
                        <span className="text-xs font-mono bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 px-2 py-0.5 rounded">
                          {Math.round(result.relevance_score)}% Match
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-300 mb-2 line-clamp-2">{result.content}</p>
                      <p className="text-xs text-gray-400 italic">Matched because: {result.reason}</p>
                    </button>
                  ))
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    No matching memories found.
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}