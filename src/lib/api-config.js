// API Configuration - handles both development and production
// In production, this will use the Render.com backend URL
// In development, it uses localhost

const getApiBaseUrl = () => {
  // Check if we're in production (deployed on Render)
  if (typeof window !== 'undefined') {
    // If the current URL is the production domain, use production API
    if (window.location.hostname === 'lykinsai-1.onrender.com' || 
        window.location.hostname.includes('onrender.com')) {
      return 'https://lykinsai-1.onrender.com';
    }
    
    // Check for environment variable (for Vite)
    const envApiUrl = import.meta.env.VITE_API_BASE_URL;
    if (envApiUrl) {
      return envApiUrl;
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
    // Use current origin in production
    if (window.location.hostname === 'lykinsai-1.onrender.com' || 
        window.location.hostname.includes('onrender.com')) {
      return window.location.origin;
    }
    
    // Check for environment variable
    const envFrontendUrl = import.meta.env.VITE_FRONTEND_BASE_URL;
    if (envFrontendUrl) {
      return envFrontendUrl;
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
  isProduction: typeof window !== 'undefined' && (window.location.hostname.includes('onrender.com'))
});
