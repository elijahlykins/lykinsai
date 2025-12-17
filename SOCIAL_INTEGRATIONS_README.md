# Social Media Integrations - Implementation Guide

## Overview

This implementation allows users to connect their social media accounts (Pinterest, Instagram, etc.) so the AI can access their interests and provide personalized recommendations.

## What's Been Implemented

### 1. Server Endpoints (`server.js`)

- **`GET /api/social/connect/:platform`** - Initiates OAuth flow for a platform
- **`GET /api/social/callback/:platform`** - Handles OAuth callback and stores tokens
- **`POST /api/social/sync/:platform`** - Syncs data from a connected platform
- **`GET /api/social/data`** - Retrieves user's social data for AI context

### 2. UI Components

- **SettingsModal** - Added "Social Integrations" section with:
  - Connect/disconnect buttons for each platform
  - Sync status and last sync time
  - Visual indicators for connected accounts

### 3. Database Schema

- Created `SUPABASE_SCHEMA.md` with SQL for:
  - `social_connections` table - Stores OAuth tokens
  - `social_data` table - Stores synced content (pins, posts, etc.)

### 4. AI Integration

- **MemoryChat** - Now includes social data in AI prompts
- Social interests are automatically included in context
- AI can reference user's Pinterest pins, Instagram posts, etc.

## Setup Instructions

### 1. Database Setup

Run the SQL from `SUPABASE_SCHEMA.md` in your Supabase SQL Editor to create the tables.

### 2. Environment Variables

Add these to your `.env` file:

```env
# Pinterest API (get from https://developers.pinterest.com/)
PINTEREST_CLIENT_ID=your_pinterest_client_id
PINTEREST_CLIENT_SECRET=your_pinterest_client_secret

# Instagram API (get from https://developers.facebook.com/)
INSTAGRAM_CLIENT_ID=your_instagram_client_id
INSTAGRAM_CLIENT_SECRET=your_instagram_client_secret
```

### 3. OAuth Redirect URIs

Configure these redirect URIs in your platform developer dashboards:

- **Pinterest**: `http://localhost:3001/api/social/callback/pinterest`
- **Instagram**: `http://localhost:3001/api/social/callback/instagram`

For production, update these to your production domain.

### 4. Get API Credentials

#### Pinterest
1. Go to https://developers.pinterest.com/
2. Create an app
3. Get your Client ID and Client Secret
4. Add redirect URI: `http://localhost:3001/api/social/callback/pinterest`

#### Instagram
1. Go to https://developers.facebook.com/
2. Create a Facebook App
3. Add Instagram Basic Display product
4. Get your Client ID and Client Secret
5. Add redirect URI: `http://localhost:3001/api/social/callback/instagram`

## How It Works

### Connection Flow

1. User clicks "Connect" in Settings
2. Server generates OAuth URL with state (includes userId)
3. User authorizes on platform
4. Platform redirects to callback endpoint
5. Server exchanges code for access token
6. Connection saved to Supabase (or localStorage as fallback)
7. Data is automatically synced

### Data Sync

1. User can manually sync by clicking refresh button
2. Data is fetched from platform API
3. Stored in `social_data` table
4. Available for AI context in chat

### AI Integration

When user chats with AI:
1. System fetches user's social data from Supabase
2. Groups by platform (Pinterest, Instagram, etc.)
3. Includes in AI prompt as "User Social Media Interests"
4. AI can reference these interests in responses

## Current Status

✅ **Completed:**
- Server endpoints for OAuth and data sync
- UI for connecting/disconnecting platforms
- Database schema documentation
- AI integration in MemoryChat
- Pinterest OAuth flow
- Instagram OAuth flow

⏳ **Pending:**
- Token encryption (currently stored in plain text)
- Automatic token refresh
- Background sync jobs
- More platforms (Twitter, TikTok, etc.)

## Security Notes

⚠️ **Important for Production:**

1. **Encrypt tokens**: Access tokens should be encrypted before storing
2. **Token refresh**: Implement automatic refresh before expiration
3. **Rate limiting**: Respect API rate limits
4. **HTTPS**: Use HTTPS in production for OAuth callbacks
5. **Row Level Security**: Ensure RLS policies are enabled in Supabase

## Testing

1. Start the server: `npm run server`
2. Open Settings modal
3. Click "Connect" for Pinterest or Instagram
4. Complete OAuth flow
5. Click refresh to sync data
6. Chat with AI - it should reference your interests!

## Troubleshooting

### OAuth callback fails
- Check redirect URI matches exactly in platform settings
- Verify environment variables are set
- Check server logs for errors

### Data not syncing
- Verify access token is valid
- Check API rate limits
- Review server logs for API errors

### AI not using social data
- Check browser console for social data logs
- Verify data exists in Supabase `social_data` table
- Ensure user is authenticated

## Next Steps

1. Add token encryption
2. Implement automatic background sync
3. Add more platforms (Twitter/X, TikTok, Reddit)
4. Add data visualization (show user's interests)
5. Add filtering/search for synced content

