import React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Brain, Sparkles, Lightbulb, MessageSquare, X, ChevronRight, ChevronLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function AIContentPanel({ 
  isOpen, 
  onToggle, 
  aiContent,
  onInsertText,
  onQuestionClick 
}) {
  const {
    suggestions = [],
    thoughts = [],
    analysis = null,
    insertedText = [],
    chatSummary = ''
  } = aiContent || {};

  return (
    <>
      {/* Toggle Button */}
      <motion.div
        initial={false}
        animate={{ x: isOpen ? 0 : 0 }}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-40"
      >
        <Button
          onClick={onToggle}
          variant="outline"
          size="icon"
          className={`h-12 w-8 rounded-l-lg rounded-r-none border-r-0 shadow-lg ${
            isOpen 
              ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700' 
              : 'bg-white/80 dark:bg-[#171515]/80 hover:bg-blue-50 dark:hover:bg-blue-900/20'
          }`}
        >
          {isOpen ? (
            <ChevronRight className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          ) : (
            <Brain className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          )}
        </Button>
      </motion.div>

      {/* AI Content Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed right-0 top-0 h-full w-96 bg-white/95 dark:bg-[#171515]/95 backdrop-blur-xl border-l border-gray-200 dark:border-gray-700 shadow-2xl z-30 flex flex-col"
          >
            {/* Header */}
            <div className="h-14 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4 bg-gradient-to-r from-blue-50/50 to-purple-50/50 dark:from-blue-900/10 dark:to-purple-900/10">
              <div className="flex items-center gap-2">
                <Brain className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <h3 className="font-semibold text-black dark:text-white">AI Content</h3>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggle}
                className="h-8 w-8 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Content */}
            <ScrollArea className="flex-1 p-4">
              <div className="space-y-6">
                {/* Suggested Questions */}
                {suggestions.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                      <Sparkles className="w-4 h-4 text-purple-500" />
                      Suggested Questions
                    </div>
                    <div className="space-y-2">
                      {suggestions.map((question, idx) => (
                        <button
                          key={idx}
                          onClick={() => onQuestionClick?.(question)}
                          className="w-full text-left p-3 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors text-sm text-gray-800 dark:text-gray-200"
                        >
                          {question}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* AI Thoughts */}
                {thoughts.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                      <Lightbulb className="w-4 h-4 text-yellow-500" />
                      AI Thoughts
                    </div>
                    <div className="space-y-2">
                      {thoughts.map((thought, idx) => (
                        <div
                          key={idx}
                          className="p-3 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-sm text-gray-800 dark:text-gray-200 italic"
                        >
                          {thought}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* AI Analysis */}
                {analysis && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                      <Brain className="w-4 h-4 text-blue-500" />
                      AI Analysis
                    </div>
                    {analysis.prediction && (
                      <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                        <div className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">Prediction</div>
                        <div className="text-sm text-gray-800 dark:text-gray-200">{analysis.prediction}</div>
                      </div>
                    )}
                    {analysis.validation && (
                      <div className="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
                        <div className="text-xs font-semibold text-green-700 dark:text-green-300 mb-1">Validation</div>
                        <div className="text-sm text-gray-800 dark:text-gray-200">{analysis.validation}</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Chat Summary */}
                {chatSummary && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                      <MessageSquare className="w-4 h-4 text-indigo-500" />
                      Chat Summary
                    </div>
                    <div className="p-3 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 text-sm text-gray-800 dark:text-gray-200">
                      {chatSummary}
                    </div>
                  </div>
                )}

                {/* Inserted AI Text */}
                {insertedText.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                      <Sparkles className="w-4 h-4 text-pink-500" />
                      AI-Generated Text
                    </div>
                    <div className="space-y-2">
                      {insertedText.map((item, idx) => (
                        <div
                          key={idx}
                          className="p-3 rounded-lg bg-pink-50 dark:bg-pink-900/20 border border-pink-200 dark:border-pink-800 text-sm text-gray-800 dark:text-gray-200"
                        >
                          <div className="text-xs font-semibold text-pink-700 dark:text-pink-300 mb-1">
                            {item.label || 'AI Text'}
                          </div>
                          <div>{item.text}</div>
                          {onInsertText && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="mt-2 w-full text-xs"
                              onClick={() => onInsertText(item.text)}
                            >
                              Insert into Editor
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Empty State */}
                {suggestions.length === 0 && 
                 thoughts.length === 0 && 
                 !analysis && 
                 !chatSummary && 
                 insertedText.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Brain className="w-12 h-12 text-gray-400 dark:text-gray-600 mb-3" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      No AI content yet
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                      AI suggestions will appear here
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

