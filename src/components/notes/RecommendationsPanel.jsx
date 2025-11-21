import React, { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles, TrendingUp, Clock, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function RecommendationsPanel({ notes, onSelectNote }) {
  const [recommendations, setRecommendations] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dismissed, setDismissed] = useState([]);
  const [showPanel, setShowPanel] = useState(false);

  useEffect(() => {
    generateRecommendations();
  }, [notes]);

  const generateRecommendations = async () => {
    setIsLoading(true);
    try {
      // Track user behavior
      const behavior = JSON.parse(localStorage.getItem('lykinsai_behavior') || '{}');
      const recentlyViewed = behavior.recentlyViewed || [];
      const frequentTags = behavior.frequentTags || [];
      const frequentFolders = behavior.frequentFolders || [];

      // Get recently active notes
      const recentNotes = notes.slice(0, 10);
      
      // Build context for AI
      const behaviorContext = `
Recent Notes: ${recentlyViewed.slice(0, 5).map(id => {
  const note = notes.find(n => n.id === id);
  return note ? note.title : '';
}).filter(Boolean).join(', ')}
Frequent Tags: ${frequentTags.slice(0, 5).join(', ')}
Frequent Folders: ${frequentFolders.slice(0, 3).join(', ')}
`;

      const notesContext = recentNotes.map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nTags: ${n.tags?.join(', ') || 'None'}\nFolder: ${n.folder || 'Uncategorized'}`
      ).join('\n\n');

      const aiRecommendations = await base44.integrations.Core.InvokeLLM({
        prompt: `Based on user behavior and their notes, suggest 3-5 relevant actions or notes they should review.

User Behavior:
${behaviorContext}

Available Notes:
${notesContext}

Provide recommendations like:
- "Review your recent notes about [topic]"
- "Connect ideas in [note A] with [note B]"
- "Revisit this note from last week: [title]"
- "Explore notes tagged with [tag]"

Return specific, actionable recommendations.`,
        response_json_schema: {
          type: 'object',
          properties: {
            recommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  noteId: { type: 'string' }
                }
              }
            }
          }
        }
      });

      setRecommendations(aiRecommendations.recommendations || []);
    } catch (error) {
      console.error('Error generating recommendations:', error);
      setRecommendations([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDismiss = (index) => {
    setDismissed([...dismissed, index]);
  };

  const handleAction = (rec) => {
    if (rec.noteId) {
      const note = notes.find(n => n.id === rec.noteId);
      if (note) {
        onSelectNote(note);
        trackBehavior('noteView', rec.noteId);
      }
    }
  };

  const trackBehavior = (action, data) => {
    const behavior = JSON.parse(localStorage.getItem('lykinsai_behavior') || '{}');
    
    if (action === 'noteView') {
      behavior.recentlyViewed = behavior.recentlyViewed || [];
      behavior.recentlyViewed = [data, ...behavior.recentlyViewed.filter(id => id !== data)].slice(0, 20);
    }
    
    localStorage.setItem('lykinsai_behavior', JSON.stringify(behavior));
  };

  const visibleRecommendations = recommendations.filter((_, idx) => !dismissed.includes(idx));

  if (isLoading || visibleRecommendations.length === 0) return null;

  return (
    <>
      <div className="mb-6">
        <Button
          onClick={() => setShowPanel(true)}
          variant="outline"
          className="border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
        >
          <Sparkles className="w-4 h-4 mr-2" />
          {visibleRecommendations.length} Recommendation{visibleRecommendations.length !== 1 ? 's' : ''} for You
        </Button>
      </div>

      {/* Recommendations Panel */}
      <Dialog open={showPanel} onOpenChange={setShowPanel}>
        <DialogContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">Recommended for You</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4 max-h-[60vh] overflow-y-auto">
            {visibleRecommendations.map((rec, idx) => (
              <Card key={idx} className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors">
                <div className="flex items-start gap-3">
                  <TrendingUp className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-black dark:text-white">{rec.title}</h4>
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{rec.description}</p>
                    {rec.noteId && (
                      <Button
                        onClick={() => {
                          handleAction(rec);
                          setShowPanel(false);
                        }}
                        variant="link"
                        className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 p-0 h-auto mt-2"
                      >
                        View Note →
                      </Button>
                    )}
                  </div>
                  <button
                    onClick={() => handleDismiss(idx)}
                    className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}