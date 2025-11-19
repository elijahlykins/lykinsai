import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sparkles, Loader2, Copy, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function NoteSummarization({ note }) {
  const [summary, setSummary] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [summaryLength, setSummaryLength] = useState('medium');
  const [copied, setCopied] = useState(false);

  const generateSummary = async () => {
    setIsGenerating(true);
    try {
      const lengthInstructions = {
        short: 'Create a very brief summary in 2-3 sentences.',
        medium: 'Create a concise summary in 5-7 sentences.',
        long: 'Create a detailed summary with key points and insights in 10-15 sentences.'
      };

      const summaryText = await base44.integrations.Core.InvokeLLM({
        prompt: `Summarize the following note. ${lengthInstructions[summaryLength]}

Title: ${note.title}
Content: ${note.content}

Provide a clear, well-structured summary that captures the main ideas and key points.`
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

      {!summary ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-400">Summary Length:</label>
            <Select value={summaryLength} onValueChange={setSummaryLength}>
              <SelectTrigger className="w-32 bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
                <SelectItem value="short">Short</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="long">Long</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button
            onClick={generateSummary}
            disabled={isGenerating}
            className="w-full bg-lavender hover:bg-lavender/80 text-dark"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating Summary...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate Summary
              </>
            )}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-4 bg-lavender/10 rounded-lg border border-lavender/20">
            <p className="text-white leading-relaxed">{summary}</p>
          </div>
          <div className="flex gap-2">
            <Select value={summaryLength} onValueChange={setSummaryLength}>
              <SelectTrigger className="w-32 bg-dark-lighter border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-dark-card border-white/10">
                <SelectItem value="short">Short</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="long">Long</SelectItem>
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
      )}
    </div>
  );
}