# Deployment Configuration

## Production URL
- **Frontend & Backend**: `https://lykinsai-1.onrender.com`

## Environment Variables

### For Production (Render.com)

Set these environment variables in your Render.com dashboard:

#### Backend Server (server.js)
```env
# AI API Keys
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GOOGLE_API_KEY=your_google_key
XAI_API_KEY=your_xai_key

# YouTube API
YOUTUBE_API_KEY=your_youtube_key

# Social Media OAuth (optional)
PINTEREST_CLIENT_ID=your_pinterest_client_id
PINTEREST_CLIENT_SECRET=your_pinterest_client_secret
INSTAGRAM_CLIENT_ID=your_instagram_client_id
INSTAGRAM_CLIENT_SECRET=your_instagram_client_secret

# Frontend URL (for OAuth redirects)
FRONTEND_URL=https://lykinsai-1.onrender.com

# Server Configuration
PORT=3001
HOST=0.0.0.0
NODE_ENV=production
```

#### Frontend (Vite)
```env
# Supabase
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key

# Optional: Override API URL (if different from auto-detection)
VITE_API_BASE_URL=https://lykinsai-1.onrender.com
VITE_FRONTEND_BASE_URL=https://lykinsai-1.onrender.com
```

## How It Works

### Automatic URL Detection
The app automatically detects if it's running in production:
- If `window.location.hostname` includes `onrender.com`, it uses `https://lykinsai-1.onrender.com`
- Otherwise, it defaults to `http://localhost:3001` for development

### API Configuration
- **Config File**: `src/lib/api-config.js`
- All frontend fetch calls use `API_BASE_URL` from this config
- Works seamlessly in both development and production

### CORS Configuration
- Server allows requests from:
  - `https://lykinsai-1.onrender.com` (production)
  - `http://localhost:5173` (development)
  - Any localhost port (development)

### OAuth Redirects
- OAuth callbacks automatically use the correct frontend URL
- Set `FRONTEND_URL` environment variable in production
- Defaults to `https://lykinsai-1.onrender.com` if not set

## Render.com Setup

1. **Create Web Service** for the backend (server.js)
   - Build Command: (none needed, just Node.js)
   - Start Command: `node server.js`
   - Environment: Node
   - Port: 3001

2. **Create Static Site** for the frontend
   - Build Command: `npm run build`
   - Publish Directory: `dist`
   - Or use the same service and serve static files

3. **Set Environment Variables** in Render dashboard

4. **Update OAuth Redirect URIs** in:
   - Pinterest: `https://lykinsai-1.onrender.com/api/social/callback/pinterest`
   - Instagram: `https://lykinsai-1.onrender.com/api/social/callback/instagram`

## Testing

After deployment:
1. Visit `https://lykinsai-1.onrender.com`
2. Check browser console for API configuration logs
3. Test AI features to verify API calls are working
4. Test file uploads and PDF extraction
