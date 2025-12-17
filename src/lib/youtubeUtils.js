// Utility functions for YouTube URL parsing and video ID extraction

/**
 * Extract video ID from various YouTube URL formats
 * @param {string} url - YouTube URL
 * @returns {string|null} - Video ID or null if not a valid YouTube URL
 */
export function extractYouTubeVideoId(url) {
  if (!url) return null;
  
  // Remove whitespace
  url = url.trim();
  
  // Patterns for different YouTube URL formats
  const patterns = [
    // YouTube Shorts format: youtube.com/shorts/VIDEO_ID (check this first)
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    // Standard watch format: youtube.com/watch?v=VIDEO_ID
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
    /youtu\.be\/([^?\n#]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // Check if it's already just a video ID (11 characters, alphanumeric and dashes)
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
    return url;
  }
  
  return null;
}

/**
 * Check if a URL is a YouTube URL
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isYouTubeUrl(url) {
  if (!url) return false;
  // Check for YouTube domain or Shorts format
  return /youtube\.com|youtu\.be/.test(url) || /youtube\.com\/shorts\//.test(url) || extractYouTubeVideoId(url) !== null;
}

/**
 * Generate YouTube embed URL
 * @param {string} videoId - YouTube video ID
 * @returns {string}
 */
export function getYouTubeEmbedUrl(videoId) {
  return `https://www.youtube.com/embed/${videoId}`;
}

/**
 * Generate YouTube watch URL
 * @param {string} videoId - YouTube video ID
 * @returns {string}
 */
export function getYouTubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

