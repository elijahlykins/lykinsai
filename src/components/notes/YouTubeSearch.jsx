import React, { useState } from 'react';
import { Search, Loader2, Play, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function YouTubeSearch({ isOpen, onClose, onSelectVideo }) {
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`http://localhost:3001/api/youtube/search?q=${encodeURIComponent(query)}&maxResults=10`);
      
      if (!response.ok) {
        throw new Error('Failed to search YouTube');
      }
      
      const data = await response.json();
      setVideos(data.videos || []);
    } catch (err) {
      console.error('Error searching YouTube:', err);
      setError(err.message);
      setVideos([]);
    } finally {
      setLoading(false);
    }
  };
  
  const handleSelectVideo = (video) => {
    if (onSelectVideo) {
      onSelectVideo(video);
    }
    onClose();
  };
  
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-white dark:bg-[#171515] border-gray-200 dark:border-gray-700 text-black dark:text-white max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-black dark:text-white">Search YouTube Videos</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSearch} className="mb-4">
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="Search for videos..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" disabled={loading || !query.trim()}>
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
            </Button>
          </div>
        </form>
        
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg mb-4">
            <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
          </div>
        )}
        
        <div className="flex-1 overflow-y-auto space-y-3">
          {videos.length === 0 && !loading && query && (
            <p className="text-center text-gray-500 dark:text-gray-400 py-8">
              No videos found. Try a different search term.
            </p>
          )}
          
          {videos.map((video) => (
            <div
              key={video.videoId}
              className="flex gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <div className="relative flex-shrink-0">
                <img
                  src={video.thumbnail}
                  alt={video.title}
                  className="w-32 h-20 object-cover rounded"
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <Play className="w-6 h-6 text-white" fill="white" />
                </div>
              </div>
              
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm text-black dark:text-white line-clamp-2 mb-1">
                  {video.title}
                </h4>
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                  {video.channelTitle}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-500 line-clamp-2">
                  {video.description}
                </p>
              </div>
              
              <Button
                onClick={() => handleSelectVideo(video)}
                size="sm"
                className="flex-shrink-0"
              >
                <Plus className="w-4 h-4 mr-1" />
                Add
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

