import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sparkles, Loader2, Copy, Check } from 'lucide-react';
// ❌ Removed base44 import

export default function NoteSummarization({ note, onUpdate }) {
  const [summary, setSummary] = useState(note.summary || null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [summaryType, setSummaryType] = useState('paragraph');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!note.summary && note.content) {
      generateSummary();
    }
  }, []);

  const generateSummary = async () => {
    setIsGenerating(true);
    try {
      const settings = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
      const personality = settings.aiPersonality || 'balanced';

      const personalityTones = {
        professional: 'Use professional, formal language.',
        balanced: 'Use clear, neutral language.',
        casual: 'Use friendly, conversational language.',
        enthusiastic: 'Use engaging, energetic language!'
      };

      const typeInstructions = {
        paragraph: 'Create a concise paragraph summary (5-7 sentences) that captures the main ideas.',
        executive: 'Create an executive summary with: 1) Key Takeaway (1 sentence), 2) Main Points (3-4 bullet points), 3) Recommendation/Next Steps (1-2 sentences).',
        bullets: 'Create a bullet-point summary with 5-8 key points. Use clear, concise bullets that capture the essential information.',
        detailed: 'Create a detailed summary with: 1) Overview, 2) Key Details, 3) Important Insights, 4) Conclusions. Be comprehensive and thorough.'
      };

      // ⚠️ Removed attachment fetching (your proxy doesn't support internet context)
      // If needed later, add a separate route like /api/fetch-url

      const prompt = `Summarize the following note. ${typeInstructions[summaryType]} ${personalityTones[personality]}

Title: ${note.title}
Content: ${note.content}

Provide a clear, well-structured summary.`;

      const response = await fetch('http://localhost:3001/api/ai/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt })
      });

      if (!response.ok) throw new Error('AI request failed');
      const { response: summaryText } = await response.json();

      setSummary(summaryText);
      
      // Save to note via callback
      if (onUpdate) {
        onUpdate({ summary: summaryText });
      }
    } catch (error) {
      console.error('Error generating summary:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="clay-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-black dark:text-white flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-lavender" />
          AI Summary
        </h3>
        {summary && (
          <Button
            onClick={handleCopy}
            variant="ghost"
            size="sm"
            className="text-gray-400 dark:text-gray-400 hover:text-black dark:hover:text-white"
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </Button>
        )}
      </div>

      {isGenerating ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-lavender" />
        </div>
      ) : summary ? (
        <div className="space-y-3">
          <div className="p-4 bg-lavender/10 rounded-lg border border-lavender/20">
            <p className="text-black dark:text-gray-300 leading-relaxed whitespace-pre-wrap">{summary}</p>
          </div>
          <div className="flex gap-2">
            <Select value={summaryType} onValueChange={setSummaryType}>
              <SelectTrigger className="w-40 bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700">
                <SelectItem value="paragraph">Paragraph</SelectItem>
                <SelectItem value="executive">Executive</SelectItem>
                <SelectItem value="bullets">Bullet Points</SelectItem>
                <SelectItem value="detailed">Detailed</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                setSummary(null);
                generateSummary();
              }}
              disabled={isGenerating}
              variant="outline"
              className="flex-1 bg-transparent border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#1f1d1d]"
            >
              Regenerate
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}