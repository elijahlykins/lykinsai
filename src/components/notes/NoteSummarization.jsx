import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sparkles, Loader2, Copy, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function NoteSummarization({ note }) {
  const [summary, setSummary] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [summaryType, setSummaryType] = useState('paragraph');
  const [copied, setCopied] = useState(false);

  React.useEffect(() => {
    generateSummary();
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

      const summaryText = await base44.integrations.Core.InvokeLLM({
        prompt: `Summarize the following note. ${typeInstructions[summaryType]} ${personalityTones[personality]}

Title: ${note.title}
Content: ${note.content}

Provide a clear, well-structured summary.`
      });

      setSummary(summaryText);
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
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-lavender" />
          AI Summary
        </h3>
        {summary && (
          <Button
            onClick={handleCopy}
            variant="ghost"
            size="sm"
            className="text-gray-400 hover:text-white"
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
            <p className="text-gray-400 leading-relaxed">{summary}</p>
          </div>
          <div className="flex gap-2">
            <Select value={summaryType} onValueChange={setSummaryType}>
              <SelectTrigger className="w-40 bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
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
              className="flex-1 bg-transparent border-white/10 text-white hover:bg-white/10"
            >
              Regenerate
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}