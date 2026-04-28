# Deployment Configuration

## Architecture
- **Frontend**: Vercel (`https://lykn.io`)
- **Backend**: Render (e.g., `https://lykn-ideation.onrender.com`)

## Environment Variables Setup

### ✅ Professional Workflow (No Manual URL Swapping!)

The app uses environment variables, so you **never need to change code** when switching between local and production:

- **Local Development**: Uses `http://localhost:3001` automatically
- **Production (Vercel)**: Uses `VITE_API_BASE_URL` from environment variables
- **No code changes needed** when pushing to GitHub! 🚀

### Frontend Environment Variables (Vercel)

Set these in your **Vercel Project Settings > Environment Variables**:

```env
# REQUIRED: Backend API URL
# Local: http://localhost:3001
# Production: https://lykn-ideation.onrender.com (your Render backend URL)
VITE_API_BASE_URL=https://lykn-ideation.onrender.com

# Optional: Frontend URL (for OAuth redirects, auto-detected if not set)
# Local: http://localhost:5173
# Production: https://your-app.vercel.app
VITE_FRONTEND_BASE_URL=https://your-app.vercel.app

# Supabase Configuration
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Backend Environment Variables (Render)

Set these in your **Render Service Settings > Environment**:

```env
# REQUIRED: Frontend URL (for CORS and OAuth redirects)
FRONTEND_URL=https://your-app.vercel.app

# Optional: Allowed Origins (comma-separated)
ALLOWED_ORIGINS=https://your-app.vercel.app,https://www.your-app.vercel.app

# AI API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
XAI_API_KEY=...

# YouTube API
YOUTUBE_API_KEY=...

# Social Media OAuth (optional)
PINTEREST_CLIENT_ID=...
PINTEREST_CLIENT_SECRET=...
INSTAGRAM_CLIENT_ID=...
INSTAGRAM_CLIENT_SECRET=...

# Server Configuration
PORT=3001
HOST=0.0.0.0
NODE_ENV=production
```

## How It Works

### Frontend API Configuration (`src/lib/api-config.js`)

The frontend automatically uses the correct backend URL:

1. **First Priority**: `VITE_API_BASE_URL` environment variable (set in Vercel)
2. **Second Priority**: Auto-detection (if on production domain, uses fallback)
3. **Default**: `http://localhost:3001` (for local development)

**Example in code:**
```javascript
// All fetch calls use this:
const { API_BASE_URL } = await import('@/lib/api-config');
fetch(`${API_BASE_URL}/api/ai/invoke`, { ... });
```

**Result:**
- Running locally → `http://localhost:3001`
- Deployed on Vercel → `https://lykn-ideation.onrender.com` (from env var)
- **No code changes needed!** ✅

### Backend CORS Configuration

The backend automatically allows requests from:
- Any `.vercel.app` domain (including preview deployments)
- `http://localhost:*` (development)
- Origins specified in `ALLOWED_ORIGINS` env var
- `FRONTEND_URL` env var (fallback)

### OAuth Redirects

- OAuth callbacks use `FRONTEND_URL` from Render environment variables
- Automatically redirects to your Vercel frontend URL

## Deployment Steps

### 1. Deploy Backend to Render

1. **Create Web Service** in Render
   - Connect your GitHub repository
   - Root Directory: `lykinsai-97a137df` (or wherever server.js is)
   - Build Command: (leave empty)
   - Start Command: `node server.js`
   - Environment: Node
   - Port: 3001

2. **Set Environment Variables** in Render (see above)

3. **Note your Render backend URL** (e.g., `https://lykn-ideation.onrender.com`)

### 2. Deploy Frontend to Vercel

1. **Import Repository** to Vercel
   - Import your GitHub repository
   - Framework Preset: Vite
   - Root Directory: `lykinsai-97a137df`

2. **Set Environment Variables** in Vercel:
   - `VITE_API_BASE_URL` = Your Render backend URL (e.g., `https://lykn-ideation.onrender.com`)
   - `VITE_FRONTEND_BASE_URL` = Your Vercel frontend URL (e.g., `https://lykn.io`)
   - All Supabase variables

3. **Deploy** - Vercel will automatically build and deploy

### 3. Update OAuth Redirect URIs

Update these in your OAuth provider dashboards:

- **Pinterest**: `https://lykn-ideation.onrender.com/api/social/callback/pinterest`
- **Instagram**: `https://lykn-ideation.onrender.com/api/social/callback/instagram`

## Local Development

### Frontend
```bash
npm run dev
# Runs on http://localhost:5173
# Automatically uses http://localhost:3001 for API calls
```

### Backend
```bash
node server.js
# Runs on http://localhost:3001
# Automatically allows requests from localhost:5173
```

### Optional: Create `.env` file for local development

Create `.env` in project root (not committed to git):

```env
# Frontend (.env)
VITE_API_BASE_URL=http://localhost:3001
VITE_FRONTEND_BASE_URL=http://localhost:5173
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key

# Backend (.env)
FRONTEND_URL=http://localhost:5173
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
# ... other API keys
```

**Note**: If you don't create `.env`, the app will use the defaults (localhost URLs).

## Testing

After deployment:
1. Visit your Vercel frontend URL
2. Open browser console (F12)
3. Look for `🔧 API Configuration:` log
4. Verify `API_BASE_URL` points to your Render backend
5. Test AI features to verify API calls are working
6. Test file uploads and PDF extraction

## Benefits of This Setup

✅ **No code changes** when switching between local and production  
✅ **Environment variables** handle all URL configuration  
✅ **Auto-detection** as fallback if env vars not set  
✅ **Professional workflow** - just push to GitHub  
✅ **Secure** - API keys never in code, only in environment variables
