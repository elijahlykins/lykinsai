import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles, Link2, Loader2, CheckCircle, XCircle, HelpCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function AIAnalysisPanel({ note, allNotes, onUpdate, onViewNote }) {
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

      // Fetch content from attached links/videos
      let attachmentContext = '';
      if (note.attachments && note.attachments.length > 0) {
        const linkAttachments = note.attachments.filter(a => a.type === 'link');
        for (const attachment of linkAttachments.slice(0, 3)) {
          try {
            const fetchedContent = await base44.integrations.Core.InvokeLLM({
              prompt: `Fetch and summarize the key content from this URL: ${attachment.url}. Focus on main ideas, key points, and important information.`,
              add_context_from_internet: true
            });
            attachmentContext += `\n\nContent from ${attachment.name || attachment.url}:\n${fetchedContent}`;
          } catch (error) {
            console.error('Error fetching attachment content:', error);
          }
        }
      }

      const analysis = await base44.integrations.Core.InvokeLLM({
        prompt: `Analyze this memory card and provide a validation opinion:

Memory Card Title: "${note.title}"
Memory Card Content: "${note.content}"${attachmentContext}

Provide a thoughtful validation that evaluates the value, clarity, and potential of this memory. Consider:
- Is this idea clear and well-articulated?
- What's valuable or interesting about it?
- Are there any concerns or limitations?
- How could it be developed further?

${personalityPrompts[personality]} ${detailPrompts[detailLevel]}`,
        response_json_schema: {
          type: 'object',
          properties: {
            validation: { type: 'string' }
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
        prompt: `Analyze this memory card and find meaningful connections to other memory cards:

Current Memory Card:
Title: "${note.title}"
Content: "${note.content}"

Other Available Memory Cards:
${notesContext}

Find memory cards that correlate with the current one based on:
- Shared themes, topics, or concepts
- Related ideas or complementary insights
- Similar contexts or applications
- Common goals or problems being addressed

Return the IDs of memory cards that have strong correlations.`,
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
    ? allNotes.filter(n => n && note.connected_notes.includes(n.id))
    : [];

  return (
    <div className="space-y-6">
      {/* AI Analysis Section */}
      <div className="clay-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-lavender" />
            <h3 className="text-lg font-semibold text-black dark:text-white">AI Analysis</h3>
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
          <div className="clay-card-mini p-4">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-mint mt-0.5 flex-shrink-0" />
              <div>
                <h4 className="font-semibold text-black mb-2">Validation Opinion</h4>
                <p className="text-sm text-gray-400 leading-relaxed">
                  {note.ai_analysis.validation}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500 text-center py-8">
            Run AI analysis to validate this memory card
          </p>
        )}
      </div>

      {/* Connections Section */}
      <div className="clay-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-blue" />
            <h3 className="text-lg font-semibold text-black dark:text-white">Connected Ideas</h3>
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
              <button
                key={connectedNote.id}
                onClick={() => onViewNote?.(connectedNote)}
                className="w-full clay-card-mini p-3 hover:opacity-70 transition-opacity text-left"
              >
                <h4 className="font-medium text-black dark:text-white text-sm mb-1">
                  {connectedNote.title}
                </h4>
                <p className="text-xs text-gray-400 dark:text-gray-500 line-clamp-2">
                  {connectedNote.content}
                </p>
              </button>
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