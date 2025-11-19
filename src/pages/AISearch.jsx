import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Loader2, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function AISearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const navigate = useNavigate();

  const { data: notes = [] } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
  });

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

  return (
    <div className="min-h-screen bg-dark flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="search"
          onViewChange={(view) => navigate(createPageUrl(view === 'short_term' ? 'ShortTerm' : view === 'long_term' ? 'LongTerm' : 'Create'))}
          onOpenSearch={() => navigate(createPageUrl('AISearch'))}
          onOpenChat={() => navigate(createPageUrl('MemoryChat'))}
          onOpenSettings={() => setSettingsOpen(true)}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-6 border-b border-white/10">
          <h1 className="text-2xl font-bold text-white mb-6">AI Search</h1>
          <div className="flex gap-2 max-w-2xl">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search by ideas, concepts, or keywords..."
              className="flex-1 bg-dark-lighter border-white/10 text-black placeholder:text-gray-500"
            />
            <Button
              onClick={handleSearch}
              disabled={isSearching || !query.trim()}
              className="bg-white text-black hover:bg-gray-200"
            >
              {isSearching ? <Loader2 className="w-4 h-4 animate-spin text-black" /> : <Search className="w-4 h-4 text-black" />}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-dark p-8">
          <div className="max-w-4xl mx-auto space-y-3">
            {results.length > 0 ? (
              results.map((note) => (
                <div key={note.id} className="clay-card p-4">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-black">{note.title}</h3>
                    <span className="text-xs text-gray-500 px-2 py-1 bg-white/5 rounded">
                      {note.storage_type === 'short_term' ? 'Short Term' : 'Long Term'}
                    </span>
                  </div>
                  <p className="text-sm text-black line-clamp-2 mb-2">{note.content}</p>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock className="w-3 h-3 text-black" />
                    <span>{format(new Date(note.created_date), 'MMM d, yyyy')}</span>
                  </div>
                </div>
              ))
            ) : query && !isSearching ? (
              <p className="text-center text-gray-500 py-12">No results found</p>
            ) : (
              <p className="text-center text-gray-500 py-12">Search for memories by ideas or concepts</p>
            )}
          </div>
        </div>
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}