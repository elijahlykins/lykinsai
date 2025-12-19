import React, { useState, useEffect, useRef } from 'react';
import { X, Link as LinkIcon, FileText, Edit2, FolderOpen } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import YouTubeEmbed from './YouTubeEmbed';

// Helper to resolve attachment type with fallback to file extension
const resolveAttachmentType = (attachment) => {
  let type = attachment.type;
  
  console.log('🔍 resolveAttachmentType called:', {
    attachmentName: attachment.name,
    attachmentType: attachment.type,
    fileType: attachment.fileType,
    fileExtension: attachment.fileExtension,
    urlPrefix: attachment.url?.substring(0, 50)
  });

  // If type is already set (like 'youtube'), use it
  if (type && type !== 'file') {
    console.log('✅ Using existing type:', type);
    return type;
  }

  // If type is 'file' or missing, try to guess from URL or name
  const url = attachment.url || '';
  const name = attachment.name || '';
  
  // Check for data URLs first - they contain MIME type info
  if (url.startsWith('data:')) {
    if (url.startsWith('data:audio/')) {
      console.log('✅ Detected audio from data URL prefix');
      return 'audio';
    } else if (url.startsWith('data:video/')) {
      return 'video';
    } else if (url.startsWith('data:image/')) {
      return 'image';
    }
  }
  
  // Check for YouTube URLs
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'youtube';
  }
  
  // Extract extension from URL or filename (case-insensitive)
  const extMatch = (url.split('/').pop() || name).match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff', 'ico'];
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'ogg', 'm4v', 'wmv', 'flv'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'];
  const pdfExts = ['pdf'];
  const wordExts = ['doc', 'docx'];
  const excelExts = ['xls', 'xlsx'];
  const powerpointExts = ['ppt', 'pptx'];
  const textExts = ['txt', 'md', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts'];

  if (imageExts.includes(ext)) {
    return 'image';
  } else if (videoExts.includes(ext)) {
    return 'video';
  } else if (audioExts.includes(ext)) {
    console.log('✅ Detected audio from file extension:', ext);
    return 'audio';
  } else if (pdfExts.includes(ext) || type === 'pdf') {
    return 'pdf';
  } else if (wordExts.includes(ext) || type === 'word') {
    return 'word';
  } else if (excelExts.includes(ext) || type === 'excel') {
    return 'excel';
  } else if (powerpointExts.includes(ext) || type === 'powerpoint') {
    return 'powerpoint';
  } else if (textExts.includes(ext) || type === 'text') {
    return 'text';
  }

  const finalType = type || 'file';
  console.log('⚠️ Could not determine type, returning:', finalType);
  return finalType;
};

// PDF Viewer Component using PDF.js
const PDFViewer = ({ attachment }) => {
  const canvasRef = useRef(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    
    const loadPDF = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        // Convert data URL to ArrayBuffer
        let arrayBuffer;
        if (attachment.url.startsWith('data:')) {
          const base64 = attachment.url.split(',')[1];
          arrayBuffer = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
        } else {
          const response = await fetch(attachment.url);
          arrayBuffer = await response.arrayBuffer();
        }

        // Load PDF using PDF.js
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
        
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        
        if (mounted) {
          setPdfDoc(pdf);
          setTotalPages(pdf.numPages);
          setCurrentPage(1);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Error loading PDF:', err);
        if (mounted) {
          setError('Failed to load PDF. Try opening in a new tab.');
          setIsLoading(false);
        }
      }
    };

    loadPDF();
    
    return () => {
      mounted = false;
    };
  }, [attachment.url]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        const renderContext = {
          canvasContext: context,
          viewport: viewport
        };
        
        await page.render(renderContext).promise;
      } catch (err) {
        console.error('Error rendering PDF page:', err);
      }
    };

    renderPage();
  }, [pdfDoc, currentPage]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div>
          <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm">PDF Document</p>
        </div>
        <div className="flex items-center gap-2">
          {totalPages > 0 && (
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                className="bg-white dark:bg-gray-800 text-black dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
                size="sm"
              >
                Previous
              </Button>
              <span className="text-sm text-black dark:text-white">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                className="bg-white dark:bg-gray-800 text-black dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
                size="sm"
              >
                Next
              </Button>
            </div>
          )}
          <Button
            onClick={() => window.open(attachment.url, '_blank')}
            className="bg-white dark:bg-gray-800 text-black dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
            size="sm"
          >
            Open in New Tab
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {isLoading && (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500 dark:text-gray-400">Loading PDF...</p>
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <p className="text-red-500">{error}</p>
            <Button
              onClick={() => window.open(attachment.url, '_blank')}
              className="bg-white dark:bg-gray-800 text-black dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Open in New Tab
            </Button>
          </div>
        )}
        {!isLoading && !error && (
          <div className="flex justify-center">
            <canvas ref={canvasRef} className="border border-gray-200 dark:border-gray-700 rounded shadow-lg" />
          </div>
        )}
        {/* Extracted Text Display */}
        {attachment.extractedText && (
          <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-black dark:text-white mb-2">Extracted Text:</h3>
            <div className="text-sm text-black dark:text-gray-300 whitespace-pre-wrap max-h-96 overflow-auto">
              {attachment.extractedText}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Audio Player Component - handles blob URL conversion for better compatibility
const AudioPlayerComponent = ({ attachment, audioMimeType }) => {
  const [audioUrl, setAudioUrl] = useState(attachment.url);
  const [error, setError] = useState(null);
  
  useEffect(() => {
    // If it's a data URL, try to convert it to a blob URL for better compatibility
    if (attachment.url?.startsWith('data:')) {
      const convertToBlob = async () => {
        try {
          console.log('🔄 Converting data URL to blob URL for better compatibility...');
          const response = await fetch(attachment.url);
          if (!response.ok) {
            throw new Error(`Failed to fetch data URL: ${response.status}`);
          }
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
          console.log('✅ Created blob URL from data URL');
          setAudioUrl(blobUrl);
        } catch (err) {
          console.error('❌ Failed to convert data URL to blob:', err);
          setError(err.message);
          // Keep using the original data URL as fallback
        }
      };
      convertToBlob();
      
      // Cleanup on unmount
      return () => {
        if (audioUrl && audioUrl.startsWith('blob:')) {
          URL.revokeObjectURL(audioUrl);
        }
      };
    }
  }, [attachment.url]);
  
  if (error) {
    return (
      <div className="text-center">
        <p className="text-red-500 dark:text-red-400 text-sm mb-2">Error loading audio</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{error}</p>
        <audio 
          src={attachment.url}
          controls 
          className="w-full h-12 mt-4" 
          preload="metadata"
        >
          Your browser does not support the audio element.
        </audio>
      </div>
    );
  }
  
  return (
    <audio 
      key={`audio-${attachment.id}-${audioUrl?.substring(0, 50)}`}
      src={audioUrl}
      controls 
      className="w-full h-12" 
      preload="metadata"
      onError={(e) => {
        const audioEl = e.target;
        const error = audioEl.error;
        console.error('❌ Audio playback error:', {
          error: error,
          code: error?.code,
          message: error?.message,
          MEDIA_ERR_ABORTED: error?.code === 1,
          MEDIA_ERR_NETWORK: error?.code === 2,
          MEDIA_ERR_DECODE: error?.code === 3,
          MEDIA_ERR_SRC_NOT_SUPPORTED: error?.code === 4,
          urlLength: audioUrl?.length,
          urlPrefix: audioUrl?.substring(0, 100),
          urlIsDataUrl: audioUrl?.startsWith('data:'),
          mimeType: audioMimeType,
          readyState: audioEl.readyState,
          networkState: audioEl.networkState
        });
      }}
      onLoadedMetadata={(e) => {
        console.log('✅ Audio metadata loaded:', {
          duration: e.target.duration,
          readyState: e.target.readyState,
          networkState: e.target.networkState
        });
      }}
      onCanPlay={(e) => {
        console.log('✅ Audio can play:', {
          readyState: e.target.readyState,
          networkState: e.target.networkState
        });
      }}
      onLoadStart={() => {
        console.log('🔄 Audio load started');
      }}
    >
      <source src={audioUrl} type={audioMimeType} />
      Your browser does not support the audio element.
    </audio>
  );
};

export default function AttachmentPanel({ attachments = [], onRemove, onUpdate, readOnly = false }) {
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const [editingCaption, setEditingCaption] = useState(null);
  const [captionText, setCaptionText] = useState('');
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupName, setGroupName] = useState('');

  // Debug: Log when preview attachment changes
  useEffect(() => {
    if (previewAttachment) {
      console.log('🔄 Preview attachment changed:', {
        id: previewAttachment.id,
        name: previewAttachment.name,
        type: previewAttachment.type,
        urlLength: previewAttachment.url?.length,
        urlPrefix: previewAttachment.url?.substring(0, 50)
      });
    }
  }, [previewAttachment]);

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
    console.log('🎵 Rendering preview for attachment:', {
      name: attachment.name,
      originalType: attachment.type,
      resolvedType: type,
      hasUrl: !!attachment.url,
      urlLength: attachment.url?.length,
      fileType: attachment.fileType,
      fileExtension: attachment.fileExtension,
      urlPrefix: attachment.url?.substring(0, 50),
      willRenderAudio: type === 'audio'
    });

    if (type === 'image') {
      return (
        <div className="w-full h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Image File</p>
          </div>
          <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
            <img 
              src={attachment.url} 
              alt={attachment.name || 'Image'} 
              className="max-w-full max-h-[70vh] object-contain rounded shadow-lg" 
            />
          </div>
        </div>
      );
    }
    if (type === 'video') {
      return (
        <div className="w-full h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Video File</p>
          </div>
          <div className="flex-1 flex items-center justify-center p-4 bg-black">
            <video src={attachment.url} className="max-w-full max-h-full rounded" controls autoPlay={false} />
          </div>
        </div>
      );
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
    if (type === 'pdf') {
      return <PDFViewer attachment={attachment} />;
    }
    if (type === 'word') {
      return (
        <div className="w-full h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Word Document</p>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {attachment.extractedText ? (
              <div className="bg-white dark:bg-gray-900 p-6 rounded border border-gray-200 dark:border-gray-700">
                <div className="text-black dark:text-gray-300 whitespace-pre-wrap">
                  {attachment.extractedText}
                </div>
              </div>
            ) : attachment.isLoading ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                <p>Extracting text from document...</p>
              </div>
            ) : (
              <div className="p-8 text-center">
                <FileText className="w-16 h-16 text-blue-500 mx-auto mb-4" />
                <p className="text-gray-500 dark:text-gray-400 mb-4">Text extraction not available for this file type</p>
                <Button
                  onClick={() => {
                    const link = document.createElement('a');
                    link.href = attachment.url;
                    link.download = attachment.name;
                    link.click();
                  }}
                  className="bg-white dark:bg-gray-800 text-black dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
                >
                  Download File
                </Button>
              </div>
            )}
          </div>
        </div>
      );
    }
    // Check for audio type - also check if URL starts with data:audio/ as fallback
    const isAudio = type === 'audio' || 
                    attachment.type === 'audio' || 
                    (attachment.url && attachment.url.startsWith('data:audio/')) ||
                    (attachment.name && /\.(mp3|wav|ogg|m4a|aac|flac|wma)$/i.test(attachment.name));
    
    if (isAudio) {
      console.log('✅ Audio detected! Type:', type, 'Attachment type:', attachment.type, 'Will render audio player');
      
      // Get MIME type from attachment or infer from file extension
      const getAudioMimeType = () => {
        if (attachment.fileType && attachment.fileType.startsWith('audio/')) {
          return attachment.fileType;
        }
        // Check data URL MIME type
        if (attachment.url && attachment.url.startsWith('data:audio/')) {
          const mimeMatch = attachment.url.match(/^data:audio\/([^;]+)/);
          if (mimeMatch) {
            return `audio/${mimeMatch[1]}`;
          }
        }
        const ext = (attachment.fileExtension || attachment.name?.split('.').pop() || '').toLowerCase();
        const mimeTypes = {
          'mp3': 'audio/mpeg',
          'wav': 'audio/wav',
          'ogg': 'audio/ogg',
          'm4a': 'audio/mp4',
          'aac': 'audio/aac',
          'flac': 'audio/flac',
          'wma': 'audio/x-ms-wma'
        };
        return mimeTypes[ext] || 'audio/mpeg';
      };

      const audioMimeType = getAudioMimeType();
      
      console.log('🎵 Rendering audio preview:', {
        name: attachment.name,
        mimeType: audioMimeType,
        urlType: attachment.url?.substring(0, 30),
        urlLength: attachment.url?.length,
        hasUrl: !!attachment.url
      });

      if (!attachment.url) {
        return (
          <div className="w-full h-full flex flex-col">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
              <p className="text-gray-500 dark:text-gray-400 text-sm">Audio File</p>
            </div>
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="text-center">
                <p className="text-red-500 dark:text-red-400">Error: No audio URL available</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Attachment data may be missing</p>
              </div>
            </div>
          </div>
        );
      }

      // Validate data URL format
      if (attachment.url.startsWith('data:')) {
        const dataUrlMatch = attachment.url.match(/^data:([^;]+);base64,(.+)$/);
        if (!dataUrlMatch) {
          console.error('❌ Invalid data URL format:', attachment.url.substring(0, 100));
          return (
            <div className="w-full h-full flex flex-col">
              <div className="p-4 border-b border-gray-200 dark:border-gray-700">
                <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
                <p className="text-gray-500 dark:text-gray-400 text-sm">Audio File</p>
              </div>
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="text-center">
                  <p className="text-red-500 dark:text-red-400">Error: Invalid audio data format</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">The audio file data appears to be corrupted</p>
                </div>
              </div>
            </div>
          );
        }
      }

      return (
        <div className="w-full h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Audio File • {audioMimeType}</p>
          </div>
          <div className="flex-1 flex items-center justify-center p-8 min-h-[200px]">
            <div className="w-full max-w-2xl space-y-4">
              <AudioPlayerComponent attachment={attachment} audioMimeType={audioMimeType} />
              <div className="text-center space-y-1">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {attachment.name}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {audioMimeType} • {attachment.fileSize ? `${(attachment.fileSize / 1024 / 1024).toFixed(2)} MB` : 'Unknown size'}
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }
    
    // If we get here and it's not audio, log why
    console.warn('⚠️ Attachment not recognized as audio:', {
      name: attachment.name,
      type: type,
      attachmentType: attachment.type,
      urlPrefix: attachment.url?.substring(0, 50)
    });
    if (type === 'excel') {
      return (
        <div className="w-full h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Excel Spreadsheet</p>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {attachment.extractedText ? (
              <div className="bg-white dark:bg-gray-900 p-6 rounded border border-gray-200 dark:border-gray-700">
                <div className="text-sm text-black dark:text-gray-300 whitespace-pre-wrap font-mono">
                  {attachment.extractedText}
                </div>
              </div>
            ) : attachment.isLoading ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                <p>Extracting spreadsheet content...</p>
              </div>
            ) : (
              <div className="p-8 text-center">
                <FileText className="w-16 h-16 text-green-500 mx-auto mb-4" />
                <p className="text-gray-500 dark:text-gray-400 mb-4">Content extraction not available</p>
                <Button
                  onClick={() => {
                    const link = document.createElement('a');
                    link.href = attachment.url;
                    link.download = attachment.name;
                    link.click();
                  }}
                  className="bg-white dark:bg-gray-800 text-black dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
                >
                  Download File
                </Button>
              </div>
            )}
          </div>
        </div>
      );
    }
    if (type === 'powerpoint') {
      return (
        <div className="w-full h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">PowerPoint Presentation</p>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {attachment.extractedText ? (
              <div className="bg-white dark:bg-gray-900 p-6 rounded border border-gray-200 dark:border-gray-700">
                <div className="text-sm text-black dark:text-gray-300 whitespace-pre-wrap">
                  {attachment.extractedText}
                </div>
              </div>
            ) : attachment.isLoading ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                <p>Extracting presentation content...</p>
              </div>
            ) : (
              <div className="p-8 text-center">
                <FileText className="w-16 h-16 text-orange-500 mx-auto mb-4" />
                <p className="text-gray-500 dark:text-gray-400 mb-4">Content extraction not available</p>
                <Button
                  onClick={() => {
                    const link = document.createElement('a');
                    link.href = attachment.url;
                    link.download = attachment.name;
                    link.click();
                  }}
                  className="bg-white dark:bg-gray-800 text-black dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
                >
                  Download File
                </Button>
              </div>
            )}
          </div>
        </div>
      );
    }
    if (type === 'text') {
      return (
        <div className="w-full h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Text File</p>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {attachment.extractedText ? (
              <div className="bg-white dark:bg-gray-900 p-6 rounded border border-gray-200 dark:border-gray-700">
                <pre className="text-sm text-black dark:text-gray-300 whitespace-pre-wrap font-mono">
                  {attachment.extractedText}
                </pre>
              </div>
            ) : attachment.isLoading ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                <p>Loading text content...</p>
              </div>
            ) : (
              <div className="p-8 text-center">
                <FileText className="w-16 h-16 text-gray-500 mx-auto mb-4" />
                <p className="text-gray-500 dark:text-gray-400 mb-4">Unable to load text content</p>
              </div>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="w-full h-full flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <p className="text-black dark:text-white font-semibold">{attachment.name}</p>
          {attachment.fileType && (
            <p className="text-gray-500 dark:text-gray-400 text-sm">{attachment.fileType}</p>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <FileText className="w-16 h-16 text-gray-500 mx-auto mb-4" />
            <Button
              onClick={() => {
                const link = document.createElement('a');
                link.href = attachment.url;
                link.download = attachment.name;
                link.click();
              }}
              className="bg-white dark:bg-gray-800 text-black dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              Download File
            </Button>
          </div>
        </div>
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
                console.log('📋 Attachment list item:', {
                  name: attachment.name,
                  originalType: attachment.type,
                  resolvedType: resolvedType,
                  willShowAudio: resolvedType === 'audio'
                });
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
                      onClick={() => {
                        // Create a fresh copy of the attachment to avoid reference issues
                        const attachmentCopy = { ...attachment };
                        console.log('🖱️ Clicked attachment:', {
                          id: attachmentCopy.id,
                          name: attachmentCopy.name,
                          type: attachmentCopy.type,
                          urlLength: attachmentCopy.url?.length,
                          urlPrefix: attachmentCopy.url?.substring(0, 50),
                          originalId: attachment.id
                        });
                        setPreviewAttachment(attachmentCopy);
                      }}
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
                      {resolvedType === 'pdf' && (
                        <div className="flex items-center gap-2 p-2">
                          <FileText className="w-4 h-4 text-red-500 flex-shrink-0" />
                          <span className="text-xs text-black dark:text-white truncate">{attachment.name}</span>
                        </div>
                      )}
                      {resolvedType === 'word' && (
                        <div className="flex items-center gap-2 p-2">
                          <FileText className="w-4 h-4 text-blue-500 flex-shrink-0" />
                          <span className="text-xs text-black dark:text-white truncate">{attachment.name}</span>
                        </div>
                      )}
                      {resolvedType === 'excel' && (
                        <div className="flex items-center gap-2 p-2">
                          <FileText className="w-4 h-4 text-green-500 flex-shrink-0" />
                          <span className="text-xs text-black dark:text-white truncate">{attachment.name}</span>
                        </div>
                      )}
                      {resolvedType === 'powerpoint' && (
                        <div className="flex items-center gap-2 p-2">
                          <FileText className="w-4 h-4 text-orange-500 flex-shrink-0" />
                          <span className="text-xs text-black dark:text-white truncate">{attachment.name}</span>
                        </div>
                      )}
                      {resolvedType === 'audio' && (() => {
                        // Get MIME type from attachment or infer from file extension
                        const getAudioMimeType = () => {
                          if (attachment.fileType && attachment.fileType.startsWith('audio/')) {
                            return attachment.fileType;
                          }
                          const ext = (attachment.fileExtension || attachment.name?.split('.').pop() || '').toLowerCase();
                          const mimeTypes = {
                            'mp3': 'audio/mpeg',
                            'wav': 'audio/wav',
                            'ogg': 'audio/ogg',
                            'm4a': 'audio/mp4',
                            'aac': 'audio/aac',
                            'flac': 'audio/flac',
                            'wma': 'audio/x-ms-wma'
                          };
                          return mimeTypes[ext] || 'audio/mpeg';
                        };
                        const audioMimeType = getAudioMimeType();
                        return (
                          <div className="p-2 space-y-2">
                            <div className="flex items-center gap-2 mb-2">
                              <FileText className="w-4 h-4 text-purple-500 flex-shrink-0" />
                              <span className="text-xs text-black dark:text-white truncate">{attachment.name}</span>
                            </div>
                            <audio 
                              src={attachment.url} 
                              controls 
                              className="w-full h-8"
                              preload="metadata"
                            >
                              <source src={attachment.url} type={audioMimeType} />
                              Your browser does not support the audio element.
                            </audio>
                          </div>
                        );
                      })()}
                      {resolvedType === 'text' && (
                        <div className="flex items-center gap-2 p-2">
                          <FileText className="w-4 h-4 text-gray-500 flex-shrink-0" />
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
        <DialogContent className="bg-white dark:bg-[#1f1d1d]/95 border-gray-200 dark:border-gray-700 text-black dark:text-white max-w-4xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-black dark:text-white">{previewAttachment?.name || 'Preview'}</DialogTitle>
            <DialogDescription className="text-gray-500 dark:text-gray-400">
              Preview attachment content
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 flex-1 overflow-auto">
            {previewAttachment && (() => {
              console.log('📋 Preview dialog rendering with attachment:', {
                id: previewAttachment.id,
                name: previewAttachment.name,
                type: previewAttachment.type,
                urlLength: previewAttachment.url?.length,
                urlPrefix: previewAttachment.url?.substring(0, 50)
              });
              return renderPreview(previewAttachment);
            })()}
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
            <DialogDescription className="text-gray-500 dark:text-gray-400">
              Add a caption to describe this attachment
            </DialogDescription>
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
            <DialogDescription className="text-gray-500 dark:text-gray-400">
              Organize this attachment into a group
            </DialogDescription>
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