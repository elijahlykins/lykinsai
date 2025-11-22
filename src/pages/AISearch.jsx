import React, { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';
import AIAnalysisPanel from '../components/notes/AIAnalysisPanel';
import NoteSummarization from '../components/notes/NoteSummarization';
import MindMapGenerator from '../components/notes/MindMapGenerator';
import AttachmentPanel from '../components/notes/AttachmentPanel';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Loader2, Clock, Filter, X, Calendar, Tag, Folder, Save, Bookmark, Trash2, Image, Video, FileText, Link } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function AISearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedNote, setSelectedNote] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [filters, setFilters] = useState({ 
    dateRange: 'all', 
    tags: [], 
    folder: 'all',
    attachmentType: 'all',
    customDateFrom: null,
    customDateTo: null
  });
  const [savedSearches, setSavedSearches] = useState([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [searchName, setSearchName] = useState('');
  const navigate = useNavigate();
  const suggestionTimeoutRef = React.useRef(null);
  const queryClient = useQueryClient();

  // Generate suggested searches based on user's notes
  const suggestedSearches = React.useMemo(() => {
    const searches = [];
    
    // Recent notes
    if (notes.length > 0) {
      searches.push('Recent thoughts and ideas');
    }
    
    // Common tags
    if (allTags.length > 0) {
      searches.push(`Notes about ${allTags[0]}`);
      if (allTags.length > 1) {
        searches.push(`${allTags[1]} related memories`);
      }
    }
    
    // Notes with attachments
    const notesWithImages = notes.filter(n => n.attachments?.some(a => a.type === 'image'));
    if (notesWithImages.length > 0) {
      searches.push('Notes with images');
    }
    
    // Recent folders
    if (allFolders.length > 0) {
      searches.push(`Everything in ${allFolders[0]}`);
    }
    
    // Time-based
    searches.push('What did I learn this week?');
    searches.push('Important ideas from last month');
    
    return searches.slice(0, 6);
  }, [notes, allTags, allFolders]);

  const { data: notes = [], isError, error } = useQuery({
    queryKey: ['notes'],
    queryFn: () => base44.entities.Note.list('-created_date'),
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    refetchOnWindowFocus: false,
    staleTime: 30000,
    cacheTime: 300000,
  });

  const updateNoteMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Note.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  const handleUpdateNote = async (id, data) => {
    await updateNoteMutation.mutateAsync({ id, data });
    setSelectedNote(prev => ({ ...prev, ...data }));
  };

  // Extract unique tags and folders
  const allTags = React.useMemo(() => {
    const tagSet = new Set();
    notes.forEach(note => {
      if (note.tags) note.tags.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [notes]);

  const allFolders = React.useMemo(() => {
    const folderSet = new Set();
    notes.forEach(note => {
      if (note.folder) folderSet.add(note.folder);
    });
    return Array.from(folderSet).sort();
  }, [notes]);

  // Load saved searches
  React.useEffect(() => {
    const saved = localStorage.getItem('lykinsai_saved_searches');
    if (saved) {
      setSavedSearches(JSON.parse(saved));
    }
  }, []);

  const loadSuggestions = async (searchQuery) => {
    if (!searchQuery.trim() || searchQuery.length < 3) {
      setSuggestions([]);
      return;
    }

    setIsLoadingSuggestions(true);
    try {
      const recentTopics = notes.slice(0, 20).map(n => n.title).join(', ');
      const commonTags = allTags.slice(0, 10).join(', ');

      const suggestionsResponse = await base44.integrations.Core.InvokeLLM({
        prompt: `Given partial search query: "${searchQuery}"
        
Recent note topics: ${recentTopics}
Common tags: ${commonTags}

Suggest 3-5 relevant search queries the user might want to search for. Be specific and relevant.
Return only the suggestions as an array.`,
        response_json_schema: {
          type: 'object',
          properties: {
            suggestions: { type: 'array', items: { type: 'string' } }
          }
        }
      });

      setSuggestions(suggestionsResponse.suggestions || []);
    } catch (error) {
      console.error('Error loading suggestions:', error);
      setSuggestions([]);
    } finally {
      setIsLoadingSuggestions(false);
    }
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    
    setIsSearching(true);
    setSuggestions([]);
    setHasSearched(true);
    try {
      // Apply filters
      let filteredNotes = notes;
      
      if (filters.dateRange === 'custom' && filters.customDateFrom) {
        const fromDate = new Date(filters.customDateFrom);
        const toDate = filters.customDateTo ? new Date(filters.customDateTo) : new Date();
        filteredNotes = filteredNotes.filter(n => {
          const noteDate = new Date(n.created_date);
          return noteDate >= fromDate && noteDate <= toDate;
        });
      } else if (filters.dateRange !== 'all') {
        const now = new Date();
        const dateThresholds = {
          'today': 1,
          'week': 7,
          'month': 30,
          'year': 365
        };
        const daysAgo = dateThresholds[filters.dateRange];
        const threshold = new Date(now.setDate(now.getDate() - daysAgo));
        filteredNotes = filteredNotes.filter(n => new Date(n.created_date) >= threshold);
      }

      if (filters.tags.length > 0) {
        filteredNotes = filteredNotes.filter(n => 
          n.tags && filters.tags.some(tag => n.tags.includes(tag))
        );
      }

      if (filters.folder !== 'all') {
        filteredNotes = filteredNotes.filter(n => n.folder === filters.folder);
      }

      if (filters.attachmentType !== 'all') {
        filteredNotes = filteredNotes.filter(n => 
          n.attachments?.some(a => a.type === filters.attachmentType)
        );
      }

      const notesContext = filteredNotes.map(n => {
        let context = `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content}\nType: ${n.storage_type}`;
        if (n.attachments && n.attachments.length > 0) {
          context += `\nAttachments: ${n.attachments.map(a => a.name || a.url).join(', ')}`;
        }
        if (n.tags && n.tags.length > 0) {
          context += `\nTags: ${n.tags.join(', ')}`;
        }
        return context;
      }).join('\n\n---\n\n');

      const searchResults = await base44.integrations.Core.InvokeLLM({
        prompt: `Process this natural language search query: "${query}"

This is a semantic search that understands:
- Questions (e.g., "What are my ideas about AI?")
- Comparisons (e.g., "Notes similar to project X")
- Temporal queries (e.g., "Recent thoughts about marketing")
- Conceptual searches (e.g., "Everything related to productivity")
- Complex requests (e.g., "Find notes with images about travel from this month")

Find the most relevant notes based on ideas, concepts, meaning, attachments, tags, and the user's intent.
For each relevant note, identify a matching text snippet (1-2 sentences) that shows why it matches the query.

Available notes:
${notesContext}

Return the IDs of relevant notes with their matching snippets, ranked by relevance.`,
        response_json_schema: {
          type: 'object',
          properties: {
            results: { 
              type: 'array', 
              items: {
                type: 'object',
                properties: {
                  note_id: { type: 'string' },
                  snippet: { type: 'string' }
                }
              }
            }
          }
        }
      });

      const foundNotes = searchResults.results?.map(result => {
        const note = filteredNotes.find(n => n.id === result.note_id);
        return note ? { ...note, snippet: result.snippet } : null;
      }).filter(Boolean) || [];

      setResults(foundNotes);
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  React.useEffect(() => {
    if (suggestionTimeoutRef.current) {
      clearTimeout(suggestionTimeoutRef.current);
    }

    if (query.trim().length >= 3) {
      suggestionTimeoutRef.current = setTimeout(() => {
        loadSuggestions(query);
      }, 500);
    } else {
      setSuggestions([]);
    }

    return () => {
      if (suggestionTimeoutRef.current) {
        clearTimeout(suggestionTimeoutRef.current);
      }
    };
  }, [query]);

  const saveSearch = () => {
    if (!searchName.trim() || !query.trim()) return;
    
    const newSearch = {
      id: Date.now(),
      name: searchName,
      query: query,
      filters: filters,
      date: new Date().toISOString()
    };
    
    const updated = [...savedSearches, newSearch];
    setSavedSearches(updated);
    localStorage.setItem('lykinsai_saved_searches', JSON.stringify(updated));
    setSearchName('');
    setShowSaveDialog(false);
  };

  const loadSearch = (search) => {
    setQuery(search.query);
    setFilters(search.filters);
  };

  const deleteSearch = (id) => {
    const updated = savedSearches.filter(s => s.id !== id);
    setSavedSearches(updated);
    localStorage.setItem('lykinsai_saved_searches', JSON.stringify(updated));
  };

  if (isError) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex items-center justify-center">
        <div className="text-center p-8 max-w-md">
          <h2 className="text-xl font-bold text-black dark:text-white mb-4">Connection Error</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{error?.message || 'Unable to load notes. Please check your connection and try again.'}</p>
          <Button onClick={() => queryClient.invalidateQueries(['notes'])} className="bg-black dark:bg-white text-white dark:text-black">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="search"
          onViewChange={(view) => navigate(createPageUrl(
            view === 'short_term' ? 'ShortTerm' : 
            view === 'long_term' ? 'LongTerm' : 
            view === 'tags' ? 'TagManagement' : 
            view === 'reminders' ? 'Reminders' : 
            view === 'trash' ? 'Trash' :
            'Create'
          ))}
          onOpenSearch={() => navigate(createPageUrl('AISearch'))}
          onOpenChat={() => navigate(createPageUrl('MemoryChat'))}
          onOpenSettings={() => setSettingsOpen(true)}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {!hasSearched ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="max-w-2xl w-full space-y-6">
              <h1 className="text-5xl font-bold text-black dark:text-white text-center flex items-center justify-center gap-3">
                <Search className="w-12 h-12" />
                Search Your Memories
              </h1>
              
              {/* Search Input */}
              <div className="relative">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="Search by ideas, concepts, or keywords..."
                      className="flex-1 bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white placeholder:text-gray-400"
                    />
                    
                    {/* Suggestions Dropdown */}
                    {suggestions.length > 0 && (
                      <div className="absolute top-full mt-1 w-full bg-white dark:bg-[#171515] border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
                        {suggestions.map((suggestion, idx) => (
                          <button
                            key={idx}
                            onClick={() => {
                              setQuery(suggestion);
                              setSuggestions([]);
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#171515]/60 first:rounded-t-lg last:rounded-b-lg"
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    onClick={handleSearch}
                    disabled={isSearching || !query.trim()}
                    className="bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90"
                  >
                    {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  </Button>
                  <Button
                    onClick={() => setShowSaveDialog(true)}
                    disabled={!query.trim()}
                    variant="outline"
                    className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#171515]"
                  >
                    <Save className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Suggested Searches */}
              {suggestedSearches.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Try searching for:</p>
                  <div className="flex gap-2 flex-wrap">
                    {suggestedSearches.map((suggestion, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          setQuery(suggestion);
                          handleSearch();
                        }}
                        className="px-4 py-2 bg-white dark:bg-[#171515] hover:bg-gray-50 dark:hover:bg-[#1f1d1d]/80 text-black dark:text-white rounded-full text-sm transition-all border border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Saved Searches */}
              {savedSearches.length > 0 && (
                <div className="flex gap-2 items-center overflow-x-auto pb-2">
                  <Bookmark className="w-4 h-4 text-gray-400 dark:text-gray-300 flex-shrink-0" />
                  {savedSearches.map(search => (
                    <div key={search.id} className="flex items-center gap-1 bg-white dark:bg-[#171515] rounded px-2 py-1 text-xs whitespace-nowrap border border-gray-200 dark:border-gray-600">
                      <button
                        onClick={() => loadSearch(search)}
                        className="text-black dark:text-white hover:underline"
                      >
                        {search.name}
                      </button>
                      <button
                        onClick={() => deleteSearch(search.id)}
                        className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="p-6 bg-glass border-b border-white/20 dark:border-gray-700/30">
              <div className="max-w-2xl mx-auto space-y-4">
            {/* Search Input */}
            <div className="relative">
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="Search by ideas, concepts, or keywords..."
                    className="flex-1 bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white placeholder:text-gray-400"
                  />
                  
                  {/* Suggestions Dropdown */}
                  {suggestions.length > 0 && (
                    <div className="absolute top-full mt-1 w-full bg-white dark:bg-[#171515] border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
                      {suggestions.map((suggestion, idx) => (
                        <button
                          key={idx}
                          onClick={() => {
                            setQuery(suggestion);
                            setSuggestions([]);
                          }}
                          className="w-full px-4 py-2 text-left text-sm text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#171515]/60 first:rounded-t-lg last:rounded-b-lg"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  onClick={handleSearch}
                  disabled={isSearching || !query.trim()}
                  className="bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90"
                >
                  {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                </Button>
                <Button
                  onClick={() => setShowSaveDialog(true)}
                  disabled={!query.trim()}
                  variant="outline"
                  className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#171515]"
                >
                  <Save className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Filters */}
            <div className="flex gap-2 flex-wrap items-center">
              <Filter className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              
              {/* Date Range Filter */}
              <Select value={filters.dateRange} onValueChange={(value) => setFilters({...filters, dateRange: value})}>
                <SelectTrigger className="w-32 h-8 bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700">
                  <SelectItem value="all">All Time</SelectItem>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="week">This Week</SelectItem>
                  <SelectItem value="month">This Month</SelectItem>
                  <SelectItem value="year">This Year</SelectItem>
                  <SelectItem value="custom">Custom Range</SelectItem>
                </SelectContent>
              </Select>

              {/* Custom Date Range */}
              {filters.dateRange === 'custom' && (
                <div className="flex gap-2 items-center">
                  <Input
                    type="date"
                    value={filters.customDateFrom || ''}
                    onChange={(e) => setFilters({...filters, customDateFrom: e.target.value})}
                    className="w-36 h-8 bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white text-xs"
                  />
                  <span className="text-xs text-gray-500 dark:text-gray-400">to</span>
                  <Input
                    type="date"
                    value={filters.customDateTo || ''}
                    onChange={(e) => setFilters({...filters, customDateTo: e.target.value})}
                    className="w-36 h-8 bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white text-xs"
                  />
                </div>
              )}

              {/* Folder Filter */}
              <Select value={filters.folder} onValueChange={(value) => setFilters({...filters, folder: value})}>
                <SelectTrigger className="w-40 h-8 bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white text-xs">
                  <SelectValue placeholder="All Folders" />
                </SelectTrigger>
                <SelectContent className="bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700">
                  <SelectItem value="all">All Folders</SelectItem>
                  {allFolders.map(folder => (
                    <SelectItem key={folder} value={folder}>{folder}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Attachment Type Filter */}
              <Select value={filters.attachmentType} onValueChange={(value) => setFilters({...filters, attachmentType: value})}>
                <SelectTrigger className="w-40 h-8 bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white text-xs">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent className="bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700">
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="image">Images</SelectItem>
                  <SelectItem value="video">Videos</SelectItem>
                  <SelectItem value="file">Files</SelectItem>
                  <SelectItem value="link">Links</SelectItem>
                </SelectContent>
              </Select>

              {/* Tag Badges */}
              {filters.tags.map(tag => (
                <Badge key={tag} className="bg-white dark:bg-[#171515] text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]/80 border border-gray-200 dark:border-gray-600">
                  {tag}
                  <button
                    onClick={() => setFilters({...filters, tags: filters.tags.filter(t => t !== tag)})}
                    className="ml-1"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}

              {/* Tag Filter Dropdown */}
              {allTags.length > 0 && (
                <Select value="" onValueChange={(value) => {
                  if (!filters.tags.includes(value)) {
                    setFilters({...filters, tags: [...filters.tags, value]});
                  }
                }}>
                  <SelectTrigger className="w-32 h-8 bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white text-xs">
                    <SelectValue placeholder="+ Add Tag" />
                  </SelectTrigger>
                  <SelectContent className="bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700">
                    {allTags.map(tag => (
                      <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Clear Filters */}
              {(filters.dateRange !== 'all' || filters.folder !== 'all' || filters.attachmentType !== 'all' || filters.tags.length > 0) && (
                <button
                  onClick={() => setFilters({ dateRange: 'all', tags: [], folder: 'all', attachmentType: 'all', customDateFrom: null, customDateTo: null })}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white"
                >
                  Clear all
                </button>
              )}
            </div>

            {/* Saved Searches */}
            {savedSearches.length > 0 && (
              <div className="flex gap-2 items-center overflow-x-auto pb-2">
                <Bookmark className="w-4 h-4 text-gray-400 dark:text-gray-300 flex-shrink-0" />
                {savedSearches.map(search => (
                  <div key={search.id} className="flex items-center gap-1 bg-white dark:bg-[#171515] rounded px-2 py-1 text-xs whitespace-nowrap border border-gray-200 dark:border-gray-600">
                    <button
                      onClick={() => loadSearch(search)}
                      className="text-black dark:text-white hover:underline"
                    >
                      {search.name}
                    </button>
                    <button
                      onClick={() => deleteSearch(search.id)}
                      className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

            <div className="flex-1 overflow-auto p-8">
              <div className="max-w-4xl mx-auto space-y-3">
                {selectedNote ? (
                  <div className="max-w-4xl mx-auto space-y-4">
                <Button
                  onClick={() => setSelectedNote(null)}
                  variant="outline"
                  className="bg-transparent border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-100 dark:hover:bg-[#171515]"
                >
                  ← Back to Results
                </Button>
              
              {/* Main Note Card */}
              <div className="clay-card p-8">
                <h2 className="text-3xl font-bold text-black dark:text-white mb-4">{selectedNote.title}</h2>
                <p className="leading-relaxed whitespace-pre-wrap text-black dark:text-white mb-4">{selectedNote.content}</p>
                
                {/* Audio */}
                {selectedNote.audio_url && (
                  <audio controls className="w-full mb-4">
                    <source src={selectedNote.audio_url} />
                  </audio>
                )}

                {/* Attachments */}
                {selectedNote.attachments && selectedNote.attachments.length > 0 && (
                  <div className="mb-4">
                    <AttachmentPanel 
                      attachments={selectedNote.attachments}
                      onUpdate={(attachments) => handleUpdateNote(selectedNote.id, { attachments })}
                    />
                  </div>
                )}

                {/* Tags and Folder */}
                <div className="flex flex-wrap gap-2 mb-4">
                  {selectedNote.tags?.map(tag => (
                    <Badge key={tag} className="bg-gray-100 dark:bg-[#1f1d1d]/80 text-gray-700 dark:text-gray-300">{tag}</Badge>
                  ))}
                  {selectedNote.folder && (
                    <Badge variant="outline" className="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300">
                      <Folder className="w-3 h-3 mr-1" />
                      {selectedNote.folder}
                    </Badge>
                  )}
                </div>

                {/* Metadata */}
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <Clock className="w-3 h-3" />
                  <span>{format(new Date(selectedNote.created_date), 'MMM d, yyyy')}</span>
                  <span className="mx-2">•</span>
                  <span>{selectedNote.storage_type === 'short_term' ? 'Short Term' : 'Long Term'}</span>
                </div>
              </div>

              {/* AI Analysis Panel */}
              <AIAnalysisPanel 
                note={selectedNote}
                allNotes={notes}
                onUpdate={(data) => handleUpdateNote(selectedNote.id, data)}
              />

              {/* Note Summarization */}
              <NoteSummarization note={selectedNote} />

              {/* Mind Map Generator */}
              {selectedNote.connected_notes && selectedNote.connected_notes.length > 0 && (
                <MindMapGenerator 
                  note={selectedNote}
                  allNotes={notes}
                />
              )}
              </div>
              ) : results.length > 0 ? (
                results.map((note) => (
                  <button
                    key={note.id}
                    onClick={() => setSelectedNote(note)}
                    className="clay-card p-4 w-full text-left hover:scale-[1.01] transition-all"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-black dark:text-white">{note.title}</h3>
                      <span className="text-xs text-gray-500 dark:text-gray-400 px-2 py-1 bg-gray-100 dark:bg-[#1f1d1d]/60 rounded">
                        {note.storage_type === 'short_term' ? 'Short Term' : 'Long Term'}
                      </span>
                    </div>

                    {/* Matching Snippet */}
                    {note.snippet && (
                      <div className="mb-2 p-2 bg-yellow-50 dark:bg-yellow-900/20 border-l-2 border-yellow-400 dark:border-yellow-600 rounded">
                        <p className="text-sm text-black dark:text-white italic">"{note.snippet}"</p>
                      </div>
                    )}

                    <p className="text-sm text-black dark:text-gray-300 line-clamp-2 mb-2">{note.content}</p>

                    {/* Tags and Attachments */}
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      {note.tags?.slice(0, 3).map(tag => (
                        <Badge key={tag} className="text-xs bg-white dark:bg-[#171515] text-black dark:text-white border border-gray-200 dark:border-gray-600">{tag}</Badge>
                      ))}
                      {note.attachments?.length > 0 && (
                        <Badge className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                          {note.attachments.length} attachment{note.attachments.length > 1 ? 's' : ''}
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <Clock className="w-3 h-3 text-black dark:text-gray-300" />
                      <span>{format(new Date(note.created_date), 'MMM d, yyyy')}</span>
                      {note.folder && (
                        <>
                          <span className="mx-2">•</span>
                          <Folder className="w-3 h-3" />
                          <span>{note.folder}</span>
                        </>
                      )}
                    </div>
                  </button>
                ))
              ) : query && !isSearching ? (
                <p className="text-center text-gray-500 dark:text-gray-400 py-12">No results found</p>
              ) : null}
              </div>
            </div>
          </>
        )}
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Save Search Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">Save Search</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium text-black dark:text-white mb-2 block">Search Name</label>
              <Input
                value={searchName}
                onChange={(e) => setSearchName(e.target.value)}
                placeholder="e.g., Recent AI notes with images"
                className="bg-white dark:bg-[#171515] border-gray-300 dark:border-gray-600 text-black dark:text-white"
              />
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              <p>Current query: "{query}"</p>
              <p className="mt-1">Active filters: {
                [
                  filters.dateRange !== 'all' && `Date: ${filters.dateRange}`,
                  filters.folder !== 'all' && `Folder: ${filters.folder}`,
                  filters.attachmentType !== 'all' && `Type: ${filters.attachmentType}`,
                  filters.tags.length > 0 && `Tags: ${filters.tags.join(', ')}`
                ].filter(Boolean).join(', ') || 'None'
              }</p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => setShowSaveDialog(false)}
              variant="outline"
              className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#171515]"
            >
              Cancel
            </Button>
            <Button
              onClick={saveSearch}
              disabled={!searchName.trim()}
              className="bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90"
            >
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}