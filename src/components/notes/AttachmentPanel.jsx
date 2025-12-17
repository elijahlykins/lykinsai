import React, { useState } from 'react';
import { X, Link as LinkIcon, FileText, Edit2, FolderOpen } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import YouTubeEmbed from './YouTubeEmbed';

// Helper to resolve attachment type with fallback to file extension
const resolveAttachmentType = (attachment) => {
  let type = attachment.type;

  // If type is already set (like 'youtube'), use it
  if (type && type !== 'file') {
    return type;
  }

  // If type is 'file' or missing, try to guess from URL or name
  const url = attachment.url || '';
  const name = attachment.name || '';
  
  // Check for YouTube URLs first
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'youtube';
  }
  
  // Extract extension from URL or filename (case-insensitive)
  const extMatch = (url.split('/').pop() || name).match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff', 'ico'];
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'ogg', 'm4v', 'wmv', 'flv'];

  if (imageExts.includes(ext)) {
    return 'image';
  } else if (videoExts.includes(ext)) {
    return 'video';
  }

  return type || 'file';
};

export default function AttachmentPanel({ attachments = [], onRemove, onUpdate, readOnly = false }) {
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const [editingCaption, setEditingCaption] = useState(null);
  const [captionText, setCaptionText] = useState('');
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupName, setGroupName] = useState('');

  const groups = [...new Set(attachments.map(a => a.group || 'Ungrouped'))];

  const handleSaveCaption = () => {
    if (editingCaption) {
      onUpdate(editingCaption, { caption: captionText });
      setEditingCaption(null);
      setCaptionText('');
    }
  };

  const handleSaveGroup = () => {
    if (editingGroup) {
      onUpdate(editingGroup, { group: groupName || 'Ungrouped' });
      setEditingGroup(null);
      setGroupName('');
    }
  };

  const renderPreview = (attachment) => {
    const type = resolveAttachmentType(attachment);

    if (type === 'image') {
      return <img src={attachment.url} alt="" className="max-w-full max-h-[70vh] object-contain rounded" />;
    }
    if (type === 'video') {
      return <video src={attachment.url} className="max-w-full max-h-[70vh] rounded" controls />;
    }
    if (type === 'youtube') {
      return (
        <div className="w-full">
          <YouTubeEmbed 
            url={attachment.url}
            videoId={attachment.videoId}
            className="w-full"
          />
        </div>
      );
    }
    if (type === 'link') {
      return (
        <div className="p-8 text-center">
          <LinkIcon className="w-16 h-16 text-white mx-auto mb-4" />
          <p className="text-white mb-4">{attachment.name}</p>
          <Button
            onClick={() => window.open(attachment.url, '_blank')}
            className="bg-white text-black hover:bg-gray-200"
          >
            Open Link
          </Button>
        </div>
      );
    }
    return (
      <div className="p-8 text-center">
        <FileText className="w-16 h-16 text-white mx-auto mb-4" />
        <p className="text-white mb-4">{attachment.name}</p>
        <Button
          onClick={() => window.open(attachment.url, '_blank')}
          className="bg-white text-black hover:bg-gray-200"
        >
          Download File
        </Button>
      </div>
    );
  };

  return (
    <div className="w-1/2 border-l border-white/10 dark:border-gray-700/30 p-4 overflow-auto flex-shrink-0">
      {groups.map(group => (
        <div key={group} className="mb-6">
          <div className="flex items-center gap-2 mb-3 px-2">
            <FolderOpen className="w-4 h-4 text-gray-400 dark:text-gray-300" />
            <h3 className="text-sm font-semibold text-gray-400 dark:text-gray-300 uppercase tracking-wide">{group}</h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">({attachments.filter(a => (a.group || 'Ungrouped') === group).length})</span>
          </div>
          
          <div className="space-y-3">
            {attachments
              .filter(a => (a.group || 'Ungrouped') === group)
              .map((attachment) => {
                const resolvedType = resolveAttachmentType(attachment);
                return (
                  <div key={attachment.id} className="clay-card p-3 relative group">
                    {!readOnly && (
                      <button
                        onClick={() => onRemove(attachment.id)}
                        className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                      >
                        <X className="w-4 h-4 text-white" />
                      </button>
                    )}
                    
                    <div
                      onClick={() => setPreviewAttachment(attachment)}
                      className="cursor-pointer"
                    >
                      {resolvedType === 'image' && (
                        <img 
                          src={attachment.url} 
                          alt={attachment.name || ''} 
                          className="w-full h-32 object-cover rounded" 
                        />
                      )}
                      {resolvedType === 'video' && (
                        <video 
                          src={attachment.url} 
                          className="w-full h-32 object-cover rounded" 
                          controls 
                        />
                      )}
                      {resolvedType === 'youtube' && (
                        <div className="w-full">
                          {attachment.thumbnail ? (
                            <img 
                              src={attachment.thumbnail} 
                              alt={attachment.name || 'YouTube Video'} 
                              className="w-full h-32 object-cover rounded" 
                            />
                          ) : (
                            <div className="w-full h-32 bg-gray-200 dark:bg-gray-700 rounded flex items-center justify-center">
                              <span className="text-xs text-gray-500">YouTube Video</span>
                            </div>
                          )}
                        </div>
                      )}
                      {resolvedType === 'link' && (
                        <div className="flex items-center gap-2 p-2">
                          <LinkIcon className="w-4 h-4 text-black dark:text-gray-300 flex-shrink-0" />
                          <span className="text-xs text-black dark:text-white truncate">{attachment.name}</span>
                        </div>
                      )}
                      {resolvedType === 'file' && (
                        <div className="flex items-center gap-2 p-2">
                          <FileText className="w-4 h-4 text-black dark:text-gray-300 flex-shrink-0" />
                          <span className="text-xs text-black dark:text-white truncate">{attachment.name}</span>
                        </div>
                      )}
                    </div>

                    {attachment.caption && (
                      <p className="text-xs text-gray-400 dark:text-gray-300 mt-2 px-2">{attachment.caption}</p>
                    )}

                    {!readOnly && (
                      <div className="flex gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => {
                            setEditingCaption(attachment.id);
                            setCaptionText(attachment.caption || '');
                          }}
                          className="text-xs text-gray-400 dark:text-gray-300 hover:text-black dark:hover:text-white flex items-center gap-1"
                        >
                          <Edit2 className="w-3 h-3" />
                          Caption
                        </button>
                        <button
                          onClick={() => {
                            setEditingGroup(attachment.id);
                            setGroupName(attachment.group || '');
                          }}
                          className="text-xs text-gray-400 dark:text-gray-300 hover:text-black dark:hover:text-white flex items-center gap-1"
                        >
                          <FolderOpen className="w-3 h-3" />
                          Group
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      ))}

      {/* Preview Dialog */}
      <Dialog open={!!previewAttachment} onOpenChange={() => setPreviewAttachment(null)}>
        <DialogContent className="bg-white dark:bg-[#1f1d1d]/95 border-gray-200 dark:border-gray-700 text-black dark:text-white max-w-4xl">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">{previewAttachment?.name || 'Preview'}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            {previewAttachment && renderPreview(previewAttachment)}
            {previewAttachment?.caption && (
              <p className="text-gray-600 dark:text-gray-400 mt-4 text-center">{previewAttachment.caption}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Caption Editor Dialog */}
      <Dialog open={!!editingCaption} onOpenChange={() => setEditingCaption(null)}>
        <DialogContent className="bg-white dark:bg-[#1f1d1d]/95 border-gray-200 dark:border-gray-700 text-black dark:text-white">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">Add Caption</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              value={captionText}
              onChange={(e) => setCaptionText(e.target.value)}
              placeholder="Enter caption..."
              className="bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white"
            />
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => setEditingCaption(null)}
                variant="ghost"
                className="text-gray-600 dark:text-gray-400"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveCaption}
                className="bg-gray-900 dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200"
              >
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Group Editor Dialog */}
      <Dialog open={!!editingGroup} onOpenChange={() => setEditingGroup(null)}>
        <DialogContent className="bg-white dark:bg-[#1f1d1d]/95 border-gray-200 dark:border-gray-700 text-black dark:text-white">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">Set Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Select value={groupName} onValueChange={setGroupName}>
              <SelectTrigger className="bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white">
                <SelectValue placeholder="Select or create group..." />
              </SelectTrigger>
              <SelectContent className="bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700">
                {groups.filter(g => g !== 'Ungrouped').map(g => (
                  <SelectItem key={g} value={g}>{g}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Or enter new group name..."
              className="bg-gray-50 dark:bg-[#1f1d1d]/80 border-gray-300 dark:border-gray-600 text-black dark:text-white"
            />
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => setEditingGroup(null)}
                variant="ghost"
                className="text-gray-600 dark:text-gray-400"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveGroup}
                className="bg-gray-900 dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200"
              >
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}