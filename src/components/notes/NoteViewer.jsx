import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Clock, Folder, Tag, X } from 'lucide-react';
import { format } from 'date-fns';
import AttachmentPanel from './AttachmentPanel';

import { Button } from '@/components/ui/button';
import { Merge } from 'lucide-react';

export default function NoteViewer({ note, isOpen, onClose, onMerge }) {
  if (!note) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold text-black dark:text-white">{note.title}</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          <p className="text-black dark:text-white whitespace-pre-wrap">{note.content}</p>
          
          {note.audio_url && (
            <audio controls className="w-full">
              <source src={note.audio_url} />
            </audio>
          )}
          
          {note.attachments && note.attachments.length > 0 && (
            <AttachmentPanel 
              attachments={note.attachments}
              onUpdate={() => {}}
              readOnly
            />
          )}
          
          <div className="flex flex-wrap gap-2">
            {note.tags?.map(tag => (
              <Badge key={tag} className="bg-gray-100 dark:bg-[#1f1d1d]/80 text-gray-700 dark:text-gray-300">
                <Tag className="w-3 h-3 mr-1" />
                {tag}
              </Badge>
            ))}
            {note.folder && (
              <Badge variant="outline" className="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300">
                <Folder className="w-3 h-3 mr-1" />
                {note.folder}
              </Badge>
            )}
          </div>
          
          <div className="flex items-center justify-between pt-4 mt-4 border-t border-gray-100 dark:border-gray-800">
            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <Clock className="w-3 h-3" />
                <span>{format(new Date(note.created_date), 'MMM d, yyyy')}</span>
                <span className="mx-2">•</span>
                <span>{note.storage_type === 'short_term' ? 'Short Term' : 'Long Term'}</span>
            </div>
            
            {onMerge && (
                <Button 
                    onClick={() => {
                        onMerge(note);
                        onClose();
                    }}
                    className="bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-2"
                >
                    <Merge className="w-4 h-4" />
                    Merge into Current
                </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}