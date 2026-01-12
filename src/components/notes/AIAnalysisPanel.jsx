import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles, Link2, Loader2, CheckCircle } from 'lucide-react';

export default function AIAnalysisPanel({ note, allNotes, onUpdateNote, onViewNote }) {
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

      // ⚠️ Removed link fetching (your proxy doesn't support internet context)
      // If you need this later, add a separate route like /api/fetch-url

      const prompt = `Analyze this memory card and provide a validation opinion:

Memory Card Title: "${note.title}"
Memory Card Content: "${note.content}"

Provide a thoughtful validation that evaluates the value, clarity, and potential of this memory. Consider:
- Is this idea clear and well-articulated?
- What's valuable or interesting about it?
- Are there any concerns or limitations?
- How could it be developed further?

${personalityPrompts[personality]} ${detailPrompts[detailLevel]}

Return ONLY a JSON object: {"validation": "Your analysis here"}`;

      const { API_BASE_URL } = await import('@/lib/api-config');
      const response = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt })
      });

      if (!response.ok) throw new Error(`AI error: ${response.statusText}`);
      const { response: aiText } = await response.json();

      let validation = 'Failed to parse AI response.';
      try {
        const result = JSON.parse(aiText);
        validation = result.validation || aiText; // fallback to raw if needed
      } catch (e) {
        validation = aiText; // use raw text if JSON fails
      }

      // ✅ Notify parent to update the note (e.g., via Supabase)
      onUpdateNote({ ...note, ai_analysis: { validation } });

    } catch (error) {
      console.error('Error analyzing note:', error);
      // Optionally show user error
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

      const notesContext = otherNotes.slice(0, 30).map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content?.substring(0, 200) || ''}`
      ).join('\n\n');

      const prompt = `Analyze this memory card and find meaningful connections to other memory cards:

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

Return ONLY a JSON array of note IDs: ["id1", "id2", ...]`;

      const { API_BASE_URL } = await import('@/lib/api-config');
      const response = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt })
      });

      if (!response.ok) throw new Error(`AI error: ${response.statusText}`);
      const { response: aiText } = await response.json();

      let connectedNoteIds = [];
      try {
        // AI might return array or object — handle both
        const parsed = JSON.parse(aiText);
        connectedNoteIds = Array.isArray(parsed) ? parsed : (parsed.connected_note_ids || []);
      } catch (e) {
        // Fallback: extract IDs from raw text (e.g., ["id1","id2"])
        const match = aiText.match(/\[([^\]]+)\]/);
        if (match) {
          try {
            connectedNoteIds = JSON.parse(`[${match[1]}]`);
          } catch {}
        }
      }

      // ✅ Notify parent to update connected notes
      onUpdateNote({ ...note, connected_notes: connectedNoteIds });

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