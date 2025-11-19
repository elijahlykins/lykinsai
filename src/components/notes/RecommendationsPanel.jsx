import React, { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles, TrendingUp, Clock, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

export default function RecommendationsPanel({ notes, onSelectNote }) {
  const [recommendations, setRecommendations] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dismissed, setDismissed] = useState([]);

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
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-blue" />
        <h3 className="text-sm font-semibold text-black">Recommended for You</h3>
      </div>
      
      <div className="grid gap-2">
        {visibleRecommendations.slice(0, 3).map((rec, idx) => (
          <Card key={idx} className="p-3 bg-blue-50 border-blue-200 hover:bg-blue-100 transition-colors">
            <div className="flex items-start gap-3">
              <TrendingUp className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium text-black">{rec.title}</h4>
                <p className="text-xs text-gray-600 mt-1">{rec.description}</p>
                {rec.noteId && (
                  <Button
                    onClick={() => handleAction(rec)}
                    variant="link"
                    className="text-xs text-blue-600 hover:text-blue-800 p-0 h-auto mt-1"
                  >
                    View Note →
                  </Button>
                )}
              </div>
              <button
                onClick={() => handleDismiss(idx)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}