import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Play, ExternalLink, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { extractYouTubeVideoId, getYouTubeEmbedUrl, getYouTubeWatchUrl } from '@/lib/youtubeUtils';

const YouTubeEmbed = React.memo(function YouTubeEmbed({ url, videoId, onRemove, onVideoDataLoaded, className = '', autoShowEmbed = false }) {
  const [videoData, setVideoData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Get video ID for localStorage key - memoize to prevent recalculation
  const id = useMemo(() => videoId || extractYouTubeVideoId(url), [videoId, url]);
  
  // Use ref to track which video IDs have been fetched to prevent re-fetching
  const hasFetchedRef = useRef(null);
  
  const [showEmbed, setShowEmbed] = useState(false); // Never auto-play
  
  // Save play state to localStorage when user clicks play
  const handlePlayClick = useCallback(() => {
    setShowEmbed(true);
    if (id) {
      try {
        localStorage.setItem(`youtube_play_${id}`, 'true');
      } catch (e) {
        console.warn('Failed to save play state:', e);
      }
    }
  }, [id]);
  
  // Memoize onVideoDataLoaded callback to prevent re-renders
  const handleVideoDataLoaded = useCallback((data) => {
    if (onVideoDataLoaded) {
      onVideoDataLoaded(data);
    }
  }, [onVideoDataLoaded]);
  
  useEffect(() => {
    if (!id) {
      setError('Invalid YouTube URL');
      setLoading(false);
      return;
    }
    
    // Only fetch once per video ID
    const cacheKey = `youtube_video_${id}`;
    if (hasFetchedRef.current === id) return;
    
    // Fetch video metadata
    const fetchVideoData = async () => {
      try {
        setLoading(true);
        hasFetchedRef.current = id;
        
        const response = await fetch(`http://localhost:3001/api/youtube/video?id=${id}`);
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to fetch video data (${response.status})`);
        }
        
        const data = await response.json();
        setVideoData(data);
        
        // Notify parent component of video data
        handleVideoDataLoaded(data);
      } catch (err) {
        console.error(`Error fetching YouTube video ${id}:`, err);
        setError(err.message);
        // Still allow embedding even if metadata fetch fails
        setVideoData({ videoId: id, title: 'YouTube Video' });
      } finally {
        setLoading(false);
      }
    };
    
    fetchVideoData();
  }, [id, handleVideoDataLoaded]);
  
  if (!id) {
    return (
      <div className={`p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg ${className}`}>
        <p className="text-red-600 dark:text-red-400 text-sm">Invalid YouTube URL</p>
      </div>
    );
  }
  
  if (loading) {
    return (
      <div className={`p-8 bg-gray-50 dark:bg-gray-800 rounded-lg flex items-center justify-center gap-3 ${className}`}>
        <Loader2 className="w-6 h-6 animate-spin text-gray-600 dark:text-gray-400" />
        <span className="text-sm text-gray-600 dark:text-gray-400">Loading video...</span>
      </div>
    );
  }
  
  if (error && !videoData) {
    return (
      <div className={`p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg ${className}`}>
        <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
      </div>
    );
  }
  
  const embedUrl = getYouTubeEmbedUrl(id);
  const watchUrl = getYouTubeWatchUrl(id);
  
  return (
    <div className={`border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-[#171515] shadow-lg w-full ${className}`}>
      {!showEmbed ? (
        // Thumbnail preview - consistent styling for all videos
        <div className="relative group cursor-pointer" onClick={handlePlayClick}>
          <div className="relative aspect-video bg-gray-100 dark:bg-gray-800 w-full">
            {videoData?.thumbnail ? (
              <img 
                src={videoData.thumbnail} 
                alt={videoData.title || 'YouTube Video'}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Play className="w-16 h-16 text-gray-400" />
              </div>
            )}
            
            {/* Play button overlay */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
              <div className="w-24 h-24 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center transition-transform hover:scale-110 shadow-2xl">
                <Play className="w-12 h-12 text-white ml-1" fill="white" />
              </div>
            </div>
            
            {/* Remove button */}
            {onRemove && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
                className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 flex items-center justify-center transition-colors z-10"
              >
                <X className="w-4 h-4 text-white" />
              </button>
            )}
          </div>
          
          {/* Video info - consistent styling */}
          <div className="p-4 bg-white dark:bg-[#171515]">
            <h4 className="font-semibold text-base text-black dark:text-white line-clamp-2 mb-2">
              {videoData?.title || 'YouTube Video'}
            </h4>
            {videoData?.channelTitle && (
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                {videoData.channelTitle}
                {videoData.durationFormatted && ` • ${videoData.durationFormatted}`}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePlayClick();
                }}
                size="sm"
                variant="default"
                className="flex-1 bg-red-600 hover:bg-red-700 text-white"
              >
                <Play className="w-4 h-4 mr-2" />
                Watch Video
              </Button>
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(watchUrl, '_blank');
                }}
                size="sm"
                variant="outline"
              >
                <ExternalLink className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      ) : (
        // Embedded player - consistent size and styling for all videos
        <div className="relative w-full">
          <div className="aspect-video w-full bg-black">
            <iframe
              key={`youtube-${id}`}
              src={embedUrl}
              title={videoData?.title || 'YouTube Video'}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              frameBorder="0"
            />
          </div>
          {onRemove && (
            <button
              onClick={onRemove}
              className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 flex items-center justify-center transition-colors z-10"
            >
              <X className="w-4 h-4 text-white" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export default YouTubeEmbed;

