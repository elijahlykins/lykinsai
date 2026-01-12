import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { HelpCircle, Loader2, MessageCircle } from 'lucide-react';
// ❌ Removed base44 import
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../../utils';

export default function FollowUpQuestions({ note, allNotes, onChatStart }) {
  const [questions, setQuestions] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const navigate = useNavigate();

  const generateQuestions = async () => {
    setIsGenerating(true);
    try {
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const personality = settings.aiPersonality || 'balanced';
      const detailLevel = settings.aiDetailLevel || 'medium';

      const personalityPrompts = {
        professional: 'Frame questions in a professional, analytical manner.',
        balanced: 'Ask thoughtful, balanced questions that encourage exploration.',
        casual: 'Use friendly, conversational questions that feel personal.',
        enthusiastic: 'Ask engaging, motivating questions that spark excitement!'
      };

      const detailPrompts = {
        brief: 'Keep questions concise and direct.',
        medium: 'Provide clear, focused questions.',
        detailed: 'Ask comprehensive, thought-provoking questions.'
      };

      const recentNotes = allNotes
        .filter(n => n.id !== note.id)
        .slice(0, 10)
        .map(n => `Title: ${n.title}\nContent: ${n.content?.substring(0, 150) || ''}`)
        .join('\n\n');

      const prompt = `Based on the current memory card and the user's past memory cards, generate 3-5 personalized follow-up questions.

Current Memory Card:
Title: "${note.title}"
Content: "${note.content}"

Recent Past Memory Cards:
${recentNotes}

Generate questions that:
- Are deeply relatable to the user based on their past memories
- Connect this memory card to themes/patterns from their other memories
- Help the user explore this idea in the context of their personal journey
- Feel personally relevant, not generic
- Encourage deeper reflection and action

${personalityPrompts[personality]} ${detailPrompts[detailLevel]}

Return ONLY a JSON object: {"questions": ["Question 1?", "Question 2?", ...]}`;

      const { API_BASE_URL } = await import('@/lib/api-config');
      const response = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt })
      });

      if (!response.ok) throw new Error('AI request failed');
      const { response: aiText } = await response.json();

      let parsedQuestions = [];
      try {
        const result = JSON.parse(aiText);
        parsedQuestions = result.questions || [];
      } catch (e) {
        // Fallback: extract array from raw text
        const match = aiText.match(/\[([^\]]+)\]/);
        if (match) {
          try {
            parsedQuestions = JSON.parse(`[${match[1]}]`);
          } catch {}
        }
      }

      setQuestions(parsedQuestions);
    } catch (error) {
      console.error('Error generating questions:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    if (allNotes.length > 1) {
      generateQuestions();
    }
  }, []);

  const handleChatWithQuestions = () => {
    if (onChatStart) {
      onChatStart(questions);
    } else {
      localStorage.setItem('chat_followup_questions', JSON.stringify({
        questions,
        noteTitle: note.title,
        noteContent: note.content,
        noteId: note.id
      }));
      navigate(createPageUrl('MemoryChat'));
    }
  };

  if (allNotes.length <= 1) {
    return null;
  }

  return (
    <div className="clay-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HelpCircle className="w-5 h-5 text-blue" />
          <h3 className="text-lg font-semibold text-black dark:text-white">Follow-Up Questions</h3>
        </div>
        {questions.length > 0 && (
          <div className="flex gap-2">
            <Button
              onClick={handleChatWithQuestions}
              size="sm"
              className="clay-button-small flex items-center gap-2"
            >
              <MessageCircle className="w-4 h-4" />
              Discuss
            </Button>
            <Button
              onClick={generateQuestions}
              disabled={isGenerating}
              size="sm"
              variant="outline"
              className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#1f1d1d]"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Generating...
                </>
              ) : (
                'Regenerate'
              )}
            </Button>
          </div>
        )}
      </div>

      {isGenerating ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-blue" />
        </div>
      ) : questions.length > 0 ? (
        <div className="clay-card-mini p-4">
          <div className="space-y-3">
            {questions.map((question, idx) => (
              <div key={idx} className="flex items-start gap-3 pb-3 border-b border-white/10 last:border-0 last:pb-0">
                <span className="text-blue font-semibold text-sm mt-0.5">{idx + 1}.</span>
                <p className="text-sm text-gray-400 leading-relaxed flex-1">
                  {question}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-500 text-center py-8">
          Create more memory cards to get personalized questions
        </p>
      )}
    </div>
  );
}