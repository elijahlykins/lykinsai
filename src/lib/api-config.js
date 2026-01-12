// API Configuration - handles both development and production
// Frontend: Vercel (e.g., https://lykinsai.vercel.app)
// Backend: Render (e.g., https://lykinsai-1.onrender.com)
// In development, it uses localhost

const getApiBaseUrl = () => {
  // Check for environment variable first (highest priority)
  // This should be set in Vercel: VITE_API_BASE_URL=https://lykinsai-1.onrender.com
  if (typeof window !== 'undefined') {
    const envApiUrl = import.meta.env.VITE_API_BASE_URL;
    if (envApiUrl) {
      return envApiUrl;
    }
    
    // Auto-detect production: if on Vercel or any production domain (not localhost)
    const isProduction = window.location.hostname !== 'localhost' && 
                         window.location.hostname !== '127.0.0.1' &&
                         !window.location.hostname.includes('192.168.');
    
    if (isProduction) {
      // Default production backend URL (should be overridden by env var)
      // Update this to your actual Render backend URL
      return 'https://lykinsai-1.onrender.com';
    }
  }
  
  // Default to localhost for development
  return 'http://localhost:3001';
};

export const API_BASE_URL = getApiBaseUrl();

// Helper function to get API URL (for dynamic imports)
export const getApiUrl = () => API_BASE_URL;

// Frontend base URL (for OAuth redirects)
const getFrontendBaseUrl = () => {
  if (typeof window !== 'undefined') {
    // Check for environment variable first
    const envFrontendUrl = import.meta.env.VITE_FRONTEND_BASE_URL;
    if (envFrontendUrl) {
      return envFrontendUrl;
    }
    
    // Use current origin in production (Vercel)
    const isProduction = window.location.hostname !== 'localhost' && 
                         window.location.hostname !== '127.0.0.1' &&
                         !window.location.hostname.includes('192.168.');
    
    if (isProduction) {
      return window.location.origin;
    }
  }
  
  // Default to localhost for development
  return 'http://localhost:5173';
};

export const FRONTEND_BASE_URL = getFrontendBaseUrl();

console.log('🔧 API Configuration:', {
  API_BASE_URL,
  FRONTEND_BASE_URL,
  hostname: typeof window !== 'undefined' ? window.location.hostname : 'server-side',
  isProduction: typeof window !== 'undefined' && 
                window.location.hostname !== 'localhost' && 
                window.location.hostname !== '127.0.0.1'
});
