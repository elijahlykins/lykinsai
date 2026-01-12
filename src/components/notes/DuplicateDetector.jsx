import React, { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle, Merge, X, Loader2 } from 'lucide-react';
// ❌ Removed base44 import
import { format } from 'date-fns';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

export default function DuplicateDetector({ 
  notes, 
  onMergeNote, 
  onDeleteNote 
}) {
  const [duplicates, setDuplicates] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [dismissed, setDismissed] = useState([]);
  const [mergeDialog, setMergeDialog] = useState(null);
  const [deleteOption, setDeleteOption] = useState('delete');
  const [showPanel, setShowPanel] = useState(false);

  useEffect(() => {
    const cached = localStorage.getItem('lykinsai_duplicates');
    if (cached) {
      try {
        const { duplicates, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < 60 * 60 * 1000) {
          setDuplicates(duplicates);
        }
      } catch (e) {}
    }
  }, []);

  const detectDuplicates = async () => {
    setIsAnalyzing(true);
    try {
      const notesContext = notes.slice(0, 50).map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content?.substring(0, 200) || ''}\nTags: ${n.tags?.join(', ') || 'None'}\nFolder: ${n.folder || 'Uncategorized'}`
      ).join('\n\n---\n\n');

      const prompt = `Analyze these notes and identify potential duplicates or highly similar notes that could be merged.

Notes:
${notesContext}

Look for:
- Notes with very similar content or ideas
- Notes that discuss the same topic from different angles
- Notes that could be consolidated for better organization

Return ONLY a JSON object: {"duplicates": [{"note1_id": "id1", "note2_id": "id2", "reason": "reason", "similarity": 0.85}, ...]}`;

      const { API_BASE_URL } = await import('@/lib/api-config');
      const response = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt })
      });

      if (!response.ok) throw new Error('AI request failed');
      const { response: aiText } = await response.json();

      let duplicatesData = [];
      try {
        const result = JSON.parse(aiText);
        duplicatesData = result.duplicates || [];
      } catch (e) {
        // Fallback parsing
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const fallback = JSON.parse(jsonMatch[0]);
            duplicatesData = fallback.duplicates || [];
          } catch {}
        }
      }

      setDuplicates(duplicatesData);
      localStorage.setItem('lykinsai_duplicates', JSON.stringify({
        duplicates: duplicatesData,
        timestamp: Date.now()
      }));
    } catch (error) {
      console.error('Error detecting duplicates:', error);
      setDuplicates([]);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleMerge = async (duplicate) => {
    const note1 = notes.find(n => n.id === duplicate.note1_id);
    const note2 = notes.find(n => n.id === duplicate.note2_id);
    if (!note1 || !note2) return;

    try {
      // Generate merged content
      const contentPrompt = `Merge these two similar notes into one comprehensive note. Combine all unique information, remove redundancies, and organize logically.

Note 1:
Title: ${note1.title}
Content: ${note1.content}

Note 2:
Title: ${note2.title}
Content: ${note2.content}

Create a well-structured merged note that captures all important information from both.`;

      const { API_BASE_URL } = await import('@/lib/api-config');
      const contentResponse = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt: contentPrompt })
      });
      const contentResult = await contentResponse.json();
      const mergedContent = contentResult.response;

      // Generate title
      const titlePrompt = `Create a concise title (max 6 words) for this merged content: "${mergedContent.substring(0, 200)}"`;
      const titleResponse = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt: titlePrompt })
      });
      const titleResult = await titleResponse.json();
      const mergedTitle = titleResult.response.trim();

      // Merge metadata
      const mergedTags = [...new Set([...(note1.tags || []), ...(note2.tags || [])])];
      const mergedAttachments = [...(note1.attachments || []), ...(note2.attachments || [])];
      const mergedConnections = [...new Set([...(note1.connected_notes || []), ...(note2.connected_notes || [])])];
      const mergedStorageType = (note1.storage_type === 'short_term' || note2.storage_type === 'short_term') 
        ? 'short_term' 
        : 'long_term';

      // Notify parent to create merged note (via Supabase)
      const mergedNote = await onMergeNote({
        title: mergedTitle,
        content: mergedContent,
        tags: mergedTags,
        folder: note1.folder || note2.folder || 'Uncategorized',
        storage_type: mergedStorageType,
        connected_notes: mergedConnections.filter(id => id !== note1.id && id !== note2.id),
        attachments: mergedAttachments,
        color: note1.color || note2.color
      });

      // Delete originals if requested
      if (deleteOption === 'delete') {
        await onDeleteNote(note1.id);
        await onDeleteNote(note2.id);
      }

      setMergeDialog(null);
      setDeleteOption('delete');
    } catch (error) {
      console.error('Error merging notes:', error);
    }
  };

  const handleDismiss = (index) => {
    setDismissed([...dismissed, index]);
  };

  const visibleDuplicates = duplicates
    .filter((_, idx) => !dismissed.includes(idx))
    .filter(d => d.similarity >= 0.7);

  if (isAnalyzing) {
    return (
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" />
        Scanning for duplicates...
      </div>
    );
  }

  if (visibleDuplicates.length === 0) {
    if (notes.length > 1) {
      return (
        <div className="mb-6">
          <Button 
            onClick={detectDuplicates}
            variant="ghost"
            size="sm"
            className="text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white text-xs"
          >
            <Merge className="w-3 h-3 mr-2" />
            Scan for Duplicates
          </Button>
        </div>
      );
    }
    return null;
  }

  return (
    <>
      <div className="mb-6">
        <Button
          onClick={() => setShowPanel(true)}
          variant="outline"
          className="border-orange-300 dark:border-orange-600 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20"
        >
          <Merge className="w-4 h-4 mr-2" />
          {visibleDuplicates.length} Potential Duplicate{visibleDuplicates.length !== 1 ? 's' : ''} Found
        </Button>
      </div>

      {/* Duplicates Panel */}
      <Dialog open={showPanel} onOpenChange={setShowPanel}>
        <DialogContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">Merge Suggestions</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4 max-h-[60vh] overflow-y-auto">
            {visibleDuplicates.map((duplicate, idx) => {
              const note1 = notes.find(n => n.id === duplicate.note1_id);
              const note2 = notes.find(n => n.id === duplicate.note2_id);
              if (!note1 || !note2) return null;

              return (
                <Card key={idx} className="p-4 bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-orange-600 dark:text-orange-400 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-black dark:text-white mb-1">
                        "{note1.title}" and "{note2.title}"
                      </p>
                      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">{duplicate.reason}</p>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => {
                            setMergeDialog(duplicate);
                            setShowPanel(false);
                          }}
                          size="sm"
                          className="bg-orange-600 text-white hover:bg-orange-700 dark:bg-orange-700 dark:hover:bg-orange-800 h-8 text-xs"
                        >
                          <Merge className="w-3 h-3 mr-1" />
                          Merge These
                        </Button>
                        <Button
                          onClick={() => handleDismiss(idx)}
                          size="sm"
                          variant="ghost"
                          className="text-gray-600 dark:text-gray-400 hover:text-black dark:hover:text-white h-8 text-xs"
                        >
                          Dismiss
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Merge Confirmation Dialog */}
      {mergeDialog && (
        <Dialog open={!!mergeDialog} onOpenChange={() => setMergeDialog(null)}>
          <DialogContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700">
            <DialogHeader>
              <DialogTitle className="text-black dark:text-white">Merge Notes</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This will merge the following notes into one comprehensive note:
              </p>
              {(() => {
                const note1 = notes.find(n => n.id === mergeDialog.note1_id);
                const note2 = notes.find(n => n.id === mergeDialog.note2_id);
                return (
                  <div className="space-y-2">
                    <div className="p-3 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded">
                      <p className="font-medium text-black dark:text-white">{note1?.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {format(new Date(note1?.created_at || note1?.created_date || Date.now()), 'MMM d, yyyy')}
                      </p>
                    </div>
                    <div className="p-3 bg-gray-50 dark:bg-[#1f1d1d]/80 rounded">
                      <p className="font-medium text-black dark:text-white">{note2?.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {format(new Date(note2?.created_at || note2?.created_date || Date.now()), 'MMM d, yyyy')}
                      </p>
                    </div>
                  </div>
                );
              })()}
              
              <div className="space-y-3 pt-4 border-t border-gray-200 dark:border-gray-700">
                <Label className="text-sm font-medium text-black dark:text-white">What should happen to the original notes?</Label>
                <RadioGroup value={deleteOption} onValueChange={setDeleteOption}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="delete" id="delete" />
                    <Label htmlFor="delete" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                      Delete originals (keep only merged note)
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="keep" id="keep" />
                    <Label htmlFor="keep" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                      Keep originals (have both merged and original notes)
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => setMergeDialog(null)}
                variant="outline"
                className="border-gray-300 dark:border-gray-600 text-black dark:text-white hover:bg-gray-50 dark:hover:bg-[#171515]"
              >
                Cancel
              </Button>
              <Button
                onClick={() => handleMerge(mergeDialog)}
                className="bg-orange-600 text-white hover:bg-orange-700 dark:bg-orange-700 dark:hover:bg-orange-800"
              >
                Merge Notes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}