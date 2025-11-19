import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles, Link2, Loader2, CheckCircle, XCircle, HelpCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function AIAnalysisPanel({ note, allNotes, onUpdate }) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isFindingConnections, setIsFindingConnections] = useState(false);

  const runAIAnalysis = async () => {
    setIsAnalyzing(true);
    try {
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const personality = settings.aiPersonality || 'balanced';
      const detailLevel = settings.aiDetailLevel || 'medium';

      const personalityPrompts = {
        professional: 'Provide a professional, objective analysis.',
        balanced: 'Be constructive, insightful, and encouraging.',
        casual: 'Be friendly, conversational, and supportive.',
        enthusiastic: 'Be enthusiastic, motivating, and highlight exciting possibilities!'
      };

      const detailPrompts = {
        brief: 'Keep responses concise and to the point.',
        medium: 'Provide moderate detail with clear explanations.',
        detailed: 'Provide comprehensive, in-depth analysis with examples.'
      };

      const analysis = await base44.integrations.Core.InvokeLLM({
        prompt: `Analyze this idea/note and provide:
1. A validation (Is this idea viable/interesting? Why or why not?)
2. Three thought-provoking questions to explore this idea further
3. Key insights or connections to consider

Note content: "${note.content}"

${personalityPrompts[personality]} ${detailPrompts[detailLevel]}`,
        response_json_schema: {
          type: 'object',
          properties: {
            validation: { type: 'string' },
            questions: { type: 'array', items: { type: 'string' } },
            insights: { type: 'string' }
          }
        }
      });

      await base44.entities.Note.update(note.id, { ai_analysis: analysis });
      onUpdate();
    } catch (error) {
      console.error('Error analyzing note:', error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const findConnections = async () => {
    setIsFindingConnections(true);
    try {
      const otherNotes = allNotes.filter(n => n.id !== note.id);
      if (otherNotes.length === 0) {
        setIsFindingConnections(false);
        return;
      }

      const notesContext = otherNotes.map(n => `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content.substring(0, 200)}`).join('\n\n');

      const connections = await base44.integrations.Core.InvokeLLM({
        prompt: `Given this note:
"${note.content}"

And these other notes:
${notesContext}

Identify which note IDs are related or connected to the main note. Return only the IDs that have meaningful connections.`,
        response_json_schema: {
          type: 'object',
          properties: {
            connected_note_ids: { type: 'array', items: { type: 'string' } }
          }
        }
      });

      await base44.entities.Note.update(note.id, {
        connected_notes: connections.connected_note_ids || []
      });
      onUpdate();
    } catch (error) {
      console.error('Error finding connections:', error);
    } finally {
      setIsFindingConnections(false);
    }
  };

  const connectedNotesList = note.connected_notes?.length > 0
    ? allNotes.filter(n => note.connected_notes.includes(n.id))
    : [];

  return (
    <div className="space-y-6">
      {/* AI Analysis Section */}
      <div className="clay-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-lavender" />
            <h3 className="text-lg font-semibold text-white">AI Analysis</h3>
          </div>
          {!note.ai_analysis && (
            <Button
              onClick={runAIAnalysis}
              disabled={isAnalyzing}
              size="sm"
              className="clay-button-small"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Analyzing...
                </>
              ) : (
                'Analyze'
              )}
            </Button>
          )}
        </div>

        {note.ai_analysis ? (
          <div className="space-y-4">
            {/* Validation */}
            <div className="clay-card-mini p-4">
              <div className="flex items-start gap-3">
                <CheckCircle className="w-5 h-5 text-mint mt-0.5 flex-shrink-0" />
                <div>
                  <h4 className="font-semibold text-white mb-2">Validation</h4>
                  <p className="text-sm text-gray-400 leading-relaxed">
                    {note.ai_analysis.validation}
                  </p>
                </div>
              </div>
            </div>

            {/* Questions */}
            {note.ai_analysis.questions?.length > 0 && (
              <div className="clay-card-mini p-4">
                <div className="flex items-start gap-3">
                  <HelpCircle className="w-5 h-5 text-blue mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-white mb-3">Questions to Explore</h4>
                    <ul className="space-y-2">
                      {note.ai_analysis.questions.map((question, idx) => (
                        <li key={idx} className="text-sm text-gray-400 leading-relaxed">
                          • {question}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* Insights */}
            {note.ai_analysis.insights && (
              <div className="clay-card-mini p-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="w-5 h-5 text-lavender mt-0.5 flex-shrink-0" />
                  <div>
                    <h4 className="font-semibold text-white mb-2">Key Insights</h4>
                    <p className="text-sm text-gray-400 leading-relaxed">
                      {note.ai_analysis.insights}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500 text-center py-8">
            Run AI analysis to validate and explore this idea
          </p>
        )}
      </div>

      {/* Connections Section */}
      <div className="clay-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-blue" />
            <h3 className="text-lg font-semibold text-white">Connected Ideas</h3>
          </div>
          <Button
            onClick={findConnections}
            disabled={isFindingConnections || allNotes.length <= 1}
            size="sm"
            className="clay-button-small"
          >
            {isFindingConnections ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Finding...
              </>
            ) : (
              'Find Connections'
            )}
          </Button>
        </div>

        {connectedNotesList.length > 0 ? (
          <div className="space-y-2">
            {connectedNotesList.map((connectedNote) => (
              <div key={connectedNote.id} className="clay-card-mini p-3">
                <h4 className="font-medium text-white text-sm mb-1">
                  {connectedNote.title}
                </h4>
                <p className="text-xs text-gray-400 line-clamp-2">
                  {connectedNote.content}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500 text-center py-8">
            {allNotes.length <= 1
              ? 'Create more notes to find connections'
              : 'No connections found yet'}
          </p>
        )}
      </div>
    </div>
  );
}