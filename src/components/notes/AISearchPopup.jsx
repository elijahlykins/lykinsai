import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

export default function AISearchPopup({ 
  isOpen, 
  selectedText, 
  onClose, 
  onSave,
  onSearch,
  preloadedDefinition = null
}) {
  const [definition, setDefinition] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  React.useEffect(() => {
    if (isOpen && selectedText) {
      // If we have a preloaded definition, use it; otherwise search
      if (preloadedDefinition) {
        setDefinition(preloadedDefinition);
        setIsLoading(false);
        setError(null);
      } else {
        handleSearch();
      }
    } else {
      setDefinition('');
      setError(null);
    }
  }, [isOpen, selectedText, preloadedDefinition]);

  const handleSearch = async () => {
    if (!selectedText || isLoading) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await onSearch?.(selectedText);
      setDefinition(result || 'No definition found.');
    } catch (err) {
      setError(err.message || 'Failed to fetch definition.');
      setDefinition('');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = () => {
    if (definition && selectedText) {
      onSave?.({
        text: selectedText,
        definition,
        id: Date.now().toString()
      });
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.9, y: 20 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col max-h-[80vh]"
        >
          {/* Header */}
          <div className="h-14 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4 bg-gradient-to-r from-blue-50/50 to-purple-50/50 dark:from-blue-900/10 dark:to-purple-900/10">
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                AI Definition
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-6 w-6"
            >
              <X className="w-3 h-3" />
            </Button>
          </div>

          {/* Content */}
          <div className="p-4 flex-1 overflow-y-auto">
            <div className="mb-3">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Selected Text:
              </span>
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mt-1 p-2 bg-gray-50 dark:bg-gray-900 rounded">
                "{selectedText}"
              </p>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-400" />
              </div>
            ) : error ? (
              <div className="text-sm text-red-600 dark:text-red-400 p-3 bg-red-50 dark:bg-red-900/20 rounded">
                {error}
              </div>
            ) : definition ? (
              <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
                {definition}
              </div>
            ) : null}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleSave}
              disabled={!definition || isLoading}
              className="flex-1"
            >
              <Save className="w-3 h-3 mr-1" />
              Save & Highlight
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
            >
              Close
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

