import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Save, Sparkles, HelpCircle, BarChart3, Brain, Network } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

export default function TextHighlighter({ 
  onHighlight, 
  onAISearch,
  onGenerateQuestions,
  onSWOTAnalysis,
  onAIThought,
  onConnectedIdeas,
  savedDefinitions = {},
  onDefinitionClick,
  onSaveDefinition 
}) {
  const [selectedText, setSelectedText] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [searchResult, setSearchResult] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleSelection = () => {
      // Check if selection is within a Quill editor
      const quillEditor = document.querySelector('.ql-editor');
      const selection = window.getSelection();
      
      if (!selection || selection.rangeCount === 0) {
        setShowMenu(false);
        setSelectedText('');
        return;
      }
      
      const range = selection.getRangeAt(0);
      const text = selection.toString().trim();
      
      // Only show menu if text is selected and it's not empty
      if (text.length > 0 && range.toString().trim().length > 0) {
        const rect = range.getBoundingClientRect();
        
        setSelectedText(text);
        setMenuPosition({
          x: rect.left + rect.width / 2,
          y: rect.top - 10
        });
        setShowMenu(true);
      } else {
        setShowMenu(false);
        setSelectedText('');
      }
    };

    const handleClick = (e) => {
      // Check if clicked element has a saved definition (highlight or indicator)
      const target = e.target;
      const highlight = target.closest('.ai-definition-highlight');
      const indicator = target.closest('.ai-definition-indicator');
      
      if (highlight || indicator) {
        const definitionId = (highlight || indicator)?.getAttribute('data-definition-id');
        if (definitionId && savedDefinitions[definitionId]) {
          e.preventDefault();
          e.stopPropagation();
          onDefinitionClick?.(savedDefinitions[definitionId]);
          return;
        }
      }
      
      if (!menuRef.current?.contains(e.target)) {
        setShowMenu(false);
      }
    };

    document.addEventListener('mouseup', handleSelection);
    document.addEventListener('click', handleClick);

    return () => {
      document.removeEventListener('mouseup', handleSelection);
      document.removeEventListener('click', handleClick);
    };
  }, [savedDefinitions, onDefinitionClick]);

  const handleAISearch = async () => {
    if (!selectedText || isSearching) return;
    
    setIsSearching(true);
    setShowMenu(false);
    
    try {
      const result = await onAISearch?.(selectedText);
      setSearchResult({
        text: selectedText,
        definition: result,
        id: Date.now().toString()
      });
    } catch (error) {
      console.error('AI search error:', error);
      setSearchResult({
        text: selectedText,
        definition: 'Sorry, I encountered an error while searching.',
        id: Date.now().toString(),
        error: true
      });
    } finally {
      setIsSearching(false);
    }
  };

  const handleSaveDefinition = () => {
    if (searchResult) {
      onSaveDefinition?.(searchResult);
      // Mark the text in the document
      markTextInDocument(searchResult.text, searchResult.id);
      setSearchResult(null);
      setSelectedText('');
    }
  };

  const markTextInDocument = (text, definitionId) => {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const span = document.createElement('span');
      span.className = 'ai-definition-highlight';
      span.setAttribute('data-definition-id', definitionId);
      span.setAttribute('title', 'Click to view definition');
      
      // Add clickable indicator area
      const indicator = document.createElement('span');
      indicator.className = 'ai-definition-indicator';
      indicator.setAttribute('data-definition-id', definitionId);
      indicator.onclick = (e) => {
        e.stopPropagation();
        if (savedDefinitions[definitionId]) {
          onDefinitionClick?.(savedDefinitions[definitionId]);
        }
      };
      
      try {
        const contents = range.extractContents();
        span.appendChild(contents);
        span.insertBefore(indicator, span.firstChild);
        range.insertNode(span);
      } catch (e) {
        // Fallback: try surroundContents
        try {
          range.surroundContents(span);
          // Add indicator after surrounding
          const indicator = document.createElement('span');
          indicator.className = 'ai-definition-indicator';
          indicator.setAttribute('data-definition-id', definitionId);
          indicator.onclick = (e) => {
            e.stopPropagation();
            if (savedDefinitions[definitionId]) {
              onDefinitionClick?.(savedDefinitions[definitionId]);
            }
          };
          span.insertBefore(indicator, span.firstChild);
        } catch (e2) {
          console.error('Failed to mark text:', e2);
        }
      }
      
      // Also make the whole span clickable
      span.onclick = (e) => {
        if (e.target !== indicator) {
          e.stopPropagation();
          if (savedDefinitions[definitionId]) {
            onDefinitionClick?.(savedDefinitions[definitionId]);
          }
        }
      };
      
      selection.removeAllRanges();
    }
  };

  return (
    <>
      {/* Context Menu */}
      <AnimatePresence>
        {showMenu && selectedText && (
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            style={{
              position: 'fixed',
              left: `${menuPosition.x}px`,
              top: `${menuPosition.y}px`,
              transform: 'translate(-50%, -100%)',
              zIndex: 10000
            }}
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-1 flex items-center gap-1"
          >
            <Button
              size="sm"
              variant="ghost"
              onClick={handleAISearch}
              disabled={isSearching}
              className="h-8 px-3 text-xs"
              title="Search for definition/summary"
            >
              <Search className="w-3 h-3 mr-1" />
              {isSearching ? 'Searching...' : 'Search'}
            </Button>
            {onGenerateQuestions && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onGenerateQuestions?.(selectedText);
                  setShowMenu(false);
                }}
                className="h-8 px-3 text-xs"
                title="Generate questions about this text"
              >
                <HelpCircle className="w-3 h-3 mr-1" />
                Questions
              </Button>
            )}
            {onSWOTAnalysis && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onSWOTAnalysis?.(selectedText);
                  setShowMenu(false);
                }}
                className="h-8 px-3 text-xs"
                title="Generate SWOT analysis"
              >
                <BarChart3 className="w-3 h-3 mr-1" />
                SWOT
              </Button>
            )}
            {onAIThought && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onAIThought?.(selectedText);
                  setShowMenu(false);
                }}
                className="h-8 px-3 text-xs"
                title="Generate AI thoughts"
              >
                <Brain className="w-3 h-3 mr-1" />
                AI Thought
              </Button>
            )}
            {onConnectedIdeas && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onConnectedIdeas?.(selectedText);
                  setShowMenu(false);
                }}
                className="h-8 px-3 text-xs"
                title="Find connected ideas"
              >
                <Network className="w-3 h-3 mr-1" />
                Connected
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onHighlight?.(selectedText);
                setShowMenu(false);
              }}
              className="h-8 px-3 text-xs"
              title="Mark text"
            >
              <Sparkles className="w-3 h-3 mr-1" />
              Mark
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search Result Popup */}
      <AnimatePresence>
        {searchResult && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="fixed bottom-6 right-6 w-96 max-h-[400px] bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 z-50 flex flex-col"
          >
            <div className="h-12 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4 bg-gradient-to-r from-blue-50/50 to-purple-50/50 dark:from-blue-900/10 dark:to-purple-900/10">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                  {searchResult.text}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSearchResult(null)}
                className="h-6 w-6"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
            
            <ScrollArea className="flex-1 p-4">
              <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                {searchResult.definition}
              </div>
            </ScrollArea>
            
            <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveDefinition}
                className="flex-1"
              >
                <Save className="w-3 h-3 mr-1" />
                Save & Highlight
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSearchResult(null)}
              >
                Close
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add CSS for glow animation */}
      <style>{`
        @keyframes glow {
          0%, 100% {
            background-position: 0% 50%;
          }
          50% {
            background-position: 100% 50%;
          }
        }
        .ai-definition-highlight:hover {
          background: linear-gradient(120deg, rgba(59, 130, 246, 0.5) 0%, rgba(147, 51, 234, 0.5) 100%) !important;
          transform: scale(1.02);
        }
      `}</style>
    </>
  );
}

