import { useState, useCallback, useRef, useEffect } from 'react';
// Note: react-dropzone needs to be installed: npm install react-dropzone
// For now, using native HTML5 drag-and-drop
// import { useDropzone } from 'react-dropzone';
import { Upload, File, X, CheckCircle2, AlertCircle, Loader2, Folder, Image, FileText, Video, Music } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/SupabaseAuth';

/**
 * DragDropFileUpload Component
 * 
 * Handles drag-and-drop file uploads with:
 * - Multiple file support
 * - Folder upload support
 * - Progress tracking
 * - Auto-processing (text extraction, embeddings, tagging)
 * 
 * This component creates an invisible overlay that captures drag-and-drop events
 * across the entire page when used in Memory page.
 */
export default function DragDropFileUpload({ onUploadComplete }) {
  const { user } = useAuth();
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState([]); // Array of { file, progress, status, error, fileId }
  const [, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  const dragHideTimeoutRef = useRef(null);
  const internalCollageDragRef = useRef(false);

  // Process FileList to handle folders
  const processFileList = useCallback(async (fileList) => {
    const files = [];
    
    for (const file of fileList) {
      // If file has webkitRelativePath, it's from a folder
      if (file.webkitRelativePath) {
        files.push({
          file,
          folderPath: file.webkitRelativePath.split('/').slice(0, -1).join('/'),
          filename: file.name
        });
      } else {
        files.push({
          file,
          folderPath: null,
          filename: file.name
        });
      }
    }
    
    return files;
  }, []);

  // Determine file type from MIME type and extension
  const getFileType = (mimeType, filename) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    
    if (mimeType?.startsWith('image/')) return 'image';
    if (mimeType?.startsWith('video/')) return 'video';
    if (mimeType?.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType?.includes('word') || ext === 'doc' || ext === 'docx') return 'doc';
    if (mimeType?.includes('excel') || ext === 'xls' || ext === 'xlsx') return 'spreadsheet';
    if (mimeType?.includes('presentation') || ext === 'ppt' || ext === 'pptx') return 'presentation';
    if (mimeType?.includes('text') || ext === 'txt' || ext === 'md') return 'text';
    
    return 'file';
  };

  const isYouTubeUrl = (url = '') =>
    /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(String(url).trim());

  const extractFirstUrl = (text = '') => {
    const match = String(text).match(/https?:\/\/[^\s<>"')]+/i);
    return match ? match[0] : '';
  };

  const createDroppedLinkNote = useCallback(async (url) => {
    if (!user?.id || !url) return false;

    const trimmedUrl = String(url).trim();
    const youtube = isYouTubeUrl(trimmedUrl);
    const attachmentPayload = [{
      type: youtube ? 'youtube' : 'link',
      url: trimmedUrl,
      name: youtube ? 'YouTube Video' : 'Saved Link'
    }];

    const noteTitle = youtube ? 'YouTube Video' : 'Saved Link';
    const noteContent = `Link saved: ${trimmedUrl}

[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;

    const richInsert = {
      user_id: user.id,
      title: noteTitle,
      content: noteContent,
      source: youtube ? 'youtube_drop' : 'link_drop',
      tags: youtube ? ['youtube', 'uploaded'] : ['link', 'uploaded'],
      attachments: JSON.stringify(attachmentPayload)
    };

    let noteError = null;
    let insertedNote = null;
    ({ data: insertedNote, error: noteError } = await supabase
      .from('notes')
      .insert(richInsert)
      .select('id, title, content, created_at, updated_at')
      .single());

    const missingColumnError =
      noteError &&
      (
        noteError.code === 'PGRST204' ||
        noteError.message?.includes('Could not find') ||
        noteError.message?.toLowerCase().includes('does not exist')
      );

    if (missingColumnError) {
      ({ data: insertedNote, error: noteError } = await supabase
        .from('notes')
        .insert({ user_id: user.id, title: noteTitle, content: noteContent })
        .select('id, title, content, created_at, updated_at')
        .single());
    }

    if (noteError) {
      console.error('Error creating dropped link note:', noteError);
      return null;
    }
    return insertedNote || null;
  }, [user?.id]);

  const extractPdfText = async (file) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      const pages = [];
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (pageText) pages.push(pageText);
      }

      return pages.join('\n\n');
    } catch (error) {
      console.warn('⚠️ PDF text extraction failed:', error?.message || error);
      return '';
    }
  };

  const createMemoryNoteForAsset = useCallback(async ({
    filename,
    folderPath,
    fileType,
    fileUrl,
    storagePath = null,
    storageBucket = "user-files",
    fileSize,
    mimeType,
    fileRecordId = null,
    extractedPdfText = '',
  }) => {
    if (!user?.id) return false;

    try {
      let folderName = 'Uploaded Files';
      if (folderPath) folderName = String(folderPath).trim();

      const noteTitle = filename.replace(/\.[^/.]+$/, '') || filename;
      const fileSizeKB = (fileSize / 1024).toFixed(2);
      const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
      const sizeDisplay = fileSize > 1024 * 1024 ? `${fileSizeMB} MB` : `${fileSizeKB} KB`;

      const safeExtractedText = extractedPdfText ? String(extractedPdfText).slice(0, 12000) : '';
      const attachmentPayload = [{
        type: fileType,
        url: fileUrl,
        name: filename,
        fileId: fileRecordId || null,
        storagePath: storagePath || undefined,
        storageBucket: storageBucket || undefined,
        size: fileSize,
        mimeType: mimeType,
        extractedText: safeExtractedText || undefined
      }];

      const noteContent = `File uploaded: ${filename}

Type: ${fileType}
Size: ${sizeDisplay}

[View File](${fileUrl})

[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;

      const richInsert = {
        user_id: user.id,
        title: noteTitle,
        content: noteContent,
        folder: folderName,
        source: 'file_upload',
        tags: [fileType, 'uploaded'],
        attachments: JSON.stringify(attachmentPayload)
      };

      let noteError = null;
      let insertedNote = null;
      ({ data: insertedNote, error: noteError } = await supabase
        .from('notes')
        .insert(richInsert)
        .select('id, title, content, created_at, updated_at')
        .single());

      const missingColumnError =
        noteError &&
        (
          noteError.code === 'PGRST204' ||
          noteError.message?.includes('Could not find') ||
          noteError.message?.toLowerCase().includes('does not exist')
        );

      if (missingColumnError) {
        ({ data: insertedNote, error: noteError } = await supabase
          .from('notes')
          .insert({
            user_id: user.id,
            title: noteTitle,
            content: noteContent
          })
          .select('id, title, content, created_at, updated_at')
          .single());
      }

      if (noteError) {
        console.error('Error creating note for file:', noteError);
        return null;
      }
      return insertedNote || null;
    } catch (error) {
      console.error('Error creating note:', error);
      return null;
    }
  }, [user?.id]);

  // Upload a single file (defined before handleFileUpload so it can be used)
  const uploadFileHandler = useCallback(async (fileData, index) => {
    const { file, folderPath, filename } = fileData;
    
    try {
      // Update status to uploading
      setUploads(prev => {
        const updated = [...prev];
        updated[index] = { ...updated[index], status: 'uploading', progress: 10 };
        return updated;
      });

      // Generate unique file ID
      const fileId = crypto.randomUUID();
      const fileExt = filename.split('.').pop() || 'bin';
      const storagePath = `${user.id}/${fileId}/original.${fileExt}`;
      const fileType = getFileType(file.type, filename);
      let fileUrl = null;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('user-files')
        .upload(storagePath, file, {
          cacheControl: '3600',
          upsert: false
        });

      if (uploadError) {
        const bucketMissing =
          uploadError?.message?.toLowerCase().includes('bucket not found') ||
          uploadError?.statusCode === 404;
        if (bucketMissing) {
          throw new Error(
            "Storage bucket 'user-files' is missing. Create it in Supabase Storage to upload media."
          );
        }
        throw uploadError;
      }

      // Use signed URLs for private buckets so new uploads preview immediately.
      const { data: signedData, error: signedError } = await supabase.storage
        .from('user-files')
        .createSignedUrl(storagePath, 60 * 60 * 24);
      if (!signedError && signedData?.signedUrl) {
        fileUrl = signedData.signedUrl;
      } else {
        const { data: urlData } = supabase.storage
          .from('user-files')
          .getPublicUrl(storagePath);
        fileUrl = urlData?.publicUrl || null;
      }

      setUploads(prev => {
        const updated = [...prev];
        updated[index] = { ...updated[index], progress: 50 };
        return updated;
      });
      
      setUploads(prev => {
        const updated = [...prev];
        updated[index] = { 
          ...updated[index], 
          progress: 70,
          status: 'uploading'
        };
        return updated;
      });

      const createdNote = await createMemoryNoteForAsset({
        filename,
        folderPath,
        fileType,
        fileUrl,
        storagePath,
        storageBucket: "user-files",
        fileSize: file.size,
        mimeType: file.type,
        fileRecordId: null,
        extractedPdfText: fileType === 'pdf' ? await extractPdfText(file) : ''
      });

      // Update to completed
      setUploads(prev => {
        const updated = [...prev];
        updated[index] = { 
          ...updated[index], 
          progress: 100, 
          status: 'completed' 
        };
        return updated;
      });

      return createdNote || null;

    } catch (error) {
      console.error('Upload error:', error);
      setUploads(prev => {
        const updated = [...prev];
        updated[index] = { 
          ...updated[index], 
          status: 'error', 
          error: error.message || 'Upload failed' 
        };
        return updated;
      });
      return null;
    }
  }, [createMemoryNoteForAsset, user]);

  // Core upload handler (used by both drag-drop and button click)
  const handleFileUpload = useCallback(async (acceptedFiles) => {
    if (!user?.id) {
      alert('Please sign in to upload files');
      return;
    }

    setIsUploading(true);
    
    // Process all files (including folder structure)
    const filesToUpload = await processFileList(acceptedFiles);
    
    // Initialize upload state for each file
    const initialUploads = filesToUpload.map(fileData => ({
      file: fileData.file,
      filename: fileData.filename,
      folderPath: fileData.folderPath,
      progress: 0,
      status: 'pending', // pending, uploading, processing, completed, error
      error: null,
      fileId: null
    }));
    
    setUploads(initialUploads);

    // Canvas-style fast behavior: lightweight pipeline with limited concurrency.
    const parallelLimit = 4;
    let cursor = 0;
    const createdNotes = [];
    const runNext = async () => {
      while (cursor < filesToUpload.length) {
        const currentIndex = cursor;
        cursor += 1;
        const createdNote = await uploadFileHandler(filesToUpload[currentIndex], currentIndex);
        if (createdNote?.id) createdNotes.push(createdNote);
      }
    };
    const workers = Array.from({ length: Math.min(parallelLimit, filesToUpload.length) }, () => runNext());
    await Promise.all(workers);
    
    setIsUploading(false);
    
    if (onUploadComplete) {
      onUploadComplete({ createdNotes });
    }
  }, [user, processFileList, uploadFileHandler, onUploadComplete]);

  // Listen for file input events from external triggers (like the attachment button)
  useEffect(() => {
    const handleFileSelect = async (e) => {
      const files = Array.from(e.detail?.files || []);
      if (files.length > 0) {
        await handleFileUpload(files);
      }
    };
    
    window.addEventListener('fileUploadTrigger', handleFileSelect);
    return () => window.removeEventListener('fileUploadTrigger', handleFileSelect);
  }, [handleFileUpload]);

  // Handle file selection (can be called from drag-drop or button click)
  const onDrop = useCallback(async (acceptedFiles) => {
    await handleFileUpload(acceptedFiles);
  }, [handleFileUpload]);

  // Ignore upload overlay while user is reordering cards in collage.
  useEffect(() => {
    const onInternalDragStart = () => {
      internalCollageDragRef.current = true;
      setIsDragging(false);
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
    };
    const onInternalDragEnd = () => {
      internalCollageDragRef.current = false;
    };
    window.addEventListener('memory_collage_reorder_drag_start', onInternalDragStart);
    window.addEventListener('memory_collage_reorder_drag_end', onInternalDragEnd);
    return () => {
      window.removeEventListener('memory_collage_reorder_drag_start', onInternalDragStart);
      window.removeEventListener('memory_collage_reorder_drag_end', onInternalDragEnd);
    };
  }, []);

  // Global drag listeners so users can drag from desktop
  // and hover/drop anywhere on the Memory page.
  useEffect(() => {
    const hasSupportedDropData = (event) => {
      if (internalCollageDragRef.current) return false;
      const types = event?.dataTransfer?.types;
      if (!types) return false;
      const allTypes = Array.from(types);
      return (
        allTypes.includes('Files') ||
        allTypes.includes('text/uri-list') ||
        allTypes.includes('text/plain')
      );
    };

    const getDroppedUrl = (event) => {
      const uriList = event?.dataTransfer?.getData('text/uri-list') || '';
      const plain = event?.dataTransfer?.getData('text/plain') || '';
      const fromUri = extractFirstUrl(uriList);
      if (fromUri) return fromUri;
      return extractFirstUrl(plain);
    };

    const onWindowDragEnter = (event) => {
      if (internalCollageDragRef.current) return;
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
      setIsDragging(true);
    };

    const onWindowDragOver = (event) => {
      if (internalCollageDragRef.current) return;
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
      setIsDragging(true);
    };

    const onWindowDragLeave = (event) => {
      if (internalCollageDragRef.current) return;
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
      }
      // Drag leave fires frequently while crossing child elements.
      // Small debounce avoids overlay flicker.
      dragHideTimeoutRef.current = window.setTimeout(() => {
        setIsDragging(false);
      }, 80);
    };

    const onWindowDrop = async (event) => {
      if (internalCollageDragRef.current) return;
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
      setIsDragging(false);
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length > 0) {
        await onDrop(files);
        return;
      }

      const droppedUrl = getDroppedUrl(event);
      if (droppedUrl && isYouTubeUrl(droppedUrl)) {
        const createdNote = await createDroppedLinkNote(droppedUrl);
        if (createdNote?.id && onUploadComplete) onUploadComplete({ createdNotes: [createdNote] });
      }
    };

    window.addEventListener('dragenter', onWindowDragEnter);
    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('dragleave', onWindowDragLeave);
    window.addEventListener('drop', onWindowDrop);

    return () => {
      window.removeEventListener('dragenter', onWindowDragEnter);
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('dragleave', onWindowDragLeave);
      window.removeEventListener('drop', onWindowDrop);
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
    };
  }, [createDroppedLinkNote, onDrop, onUploadComplete]);

  // Get file icon based on type
  const getFileIcon = (fileType) => {
    switch (fileType) {
      case 'image': return <Image className="w-5 h-5" />;
      case 'video': return <Video className="w-5 h-5" />;
      case 'audio': return <Music className="w-5 h-5" />;
      case 'pdf': return <FileText className="w-5 h-5" />;
      case 'doc':
      case 'spreadsheet':
      case 'presentation':
      case 'text': return <FileText className="w-5 h-5" />;
      default: return <File className="w-5 h-5" />;
    }
  };

  const handleFileInput = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onDrop(files);
    }
  };

  // Remove upload from list
  return (
    <>
      {/* Invisible drag-and-drop overlay - always active */}
      <div
        className={`
          fixed inset-0
          ${isDragging
            ? 'pointer-events-none bg-blue-500/20 dark:bg-blue-900/30 border-4 border-dashed border-blue-500 z-[9999]'
            : 'pointer-events-none'
          }
          transition-all duration-200
        `}
      >
        {isDragging && (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="p-6 rounded-full bg-blue-100 dark:bg-blue-900/30">
              <Upload className="w-12 h-12 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-black dark:text-white mb-2">
                Drop files or folders here
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Supports folders, PDFs, images, videos, documents
              </p>
            </div>
          </div>
        )}
      </div>
      
      {/* Hidden file input for folder selection */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInput}
        multiple
        webkitdirectory=""
        style={{ display: 'none' }}
      />

      {/* Upload Progress List - Fixed position overlay */}
      {uploads.length > 0 && (
        <div className="fixed bottom-24 right-8 w-80 max-h-96 overflow-y-auto bg-white dark:bg-[#171515] border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-4 z-[10000] space-y-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-black dark:text-white">
              Upload Progress ({uploads.filter(u => u.status === 'completed').length}/{uploads.length})
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setUploads([])}
              className="h-6 w-6 p-0"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
          
          {uploads.map((upload, index) => (
            <div
              key={index}
              className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-white dark:bg-[#171515]"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {getFileIcon(getFileType(upload.file.type, upload.filename))}
                  <span className="text-sm font-medium text-black dark:text-white truncate">
                    {upload.filename}
                  </span>
                  {upload.folderPath && (
                    <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                      <Folder className="w-3 h-3" />
                      {upload.folderPath}
                    </span>
                  )}
                </div>
                
                <div className="flex items-center gap-2">
                  {upload.status === 'completed' && (
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                  )}
                  {upload.status === 'error' && (
                    <AlertCircle className="w-5 h-5 text-red-500" />
                  )}
                  {upload.status === 'processing' && (
                    <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                  )}
                  {upload.status === 'uploading' && (
                    <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                  )}
                </div>
              </div>
              
              <Progress value={upload.progress} className="h-2" />
              
              {upload.error && (
                <p className="text-xs text-red-500 mt-1">{upload.error}</p>
              )}
              
              {upload.status === 'processing' && (
                <p className="text-xs text-blue-500 mt-1">
                  Processing: Extracting text, generating embeddings...
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
