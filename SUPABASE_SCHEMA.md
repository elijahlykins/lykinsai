# Supabase Database Schema for Social Media Integrations

This document describes the database tables needed for social media platform integrations.

## Tables

### 1. `social_connections`

Stores OAuth connections to social media platforms.

```sql
CREATE TABLE social_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- 'pinterest', 'instagram', 'twitter', etc.
  access_token TEXT NOT NULL, -- Encrypted in production
  refresh_token TEXT,
  token_expires_at TIMESTAMP,
  platform_user_id TEXT,
  platform_username TEXT,
  connected_at TIMESTAMP DEFAULT NOW(),
  last_synced_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

-- Index for faster lookups
CREATE INDEX idx_social_connections_user_id ON social_connections(user_id);
CREATE INDEX idx_social_connections_platform ON social_connections(platform);
CREATE INDEX idx_social_connections_active ON social_connections(is_active) WHERE is_active = true;

-- Enable Row Level Security (RLS)
ALTER TABLE social_connections ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own connections
CREATE POLICY "Users can view own connections"
  ON social_connections FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Users can insert their own connections
CREATE POLICY "Users can insert own connections"
  ON social_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own connections
CREATE POLICY "Users can update own connections"
  ON social_connections FOR UPDATE
  USING (auth.uid() = user_id);

-- Policy: Users can delete their own connections
CREATE POLICY "Users can delete own connections"
  ON social_connections FOR DELETE
  USING (auth.uid() = user_id);
```

### 2. `social_data`

Stores synced content from social media platforms (pins, posts, etc.).

```sql
CREATE TABLE social_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- 'pinterest', 'instagram', etc.
  data_type TEXT NOT NULL, -- 'pin', 'post', 'board', 'story', etc.
  platform_item_id TEXT NOT NULL, -- ID from the platform
  title TEXT,
  description TEXT,
  image_url TEXT,
  url TEXT,
  metadata JSONB, -- Store platform-specific data (board info, tags, etc.)
  created_at TIMESTAMP, -- When the item was created on the platform
  synced_at TIMESTAMP DEFAULT NOW(), -- When we synced it
  created_at_db TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, platform, platform_item_id)
);

-- Indexes for faster queries
CREATE INDEX idx_social_data_user_id ON social_data(user_id);
CREATE INDEX idx_social_data_platform ON social_data(platform);
CREATE INDEX idx_social_data_type ON social_data(data_type);
CREATE INDEX idx_social_data_synced ON social_data(synced_at DESC);

-- Full-text search index for descriptions
CREATE INDEX idx_social_data_description_search ON social_data USING gin(to_tsvector('english', description));

-- Enable Row Level Security (RLS)
ALTER TABLE social_data ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own data
CREATE POLICY "Users can view own social data"
  ON social_data FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Users can insert their own data
CREATE POLICY "Users can insert own social data"
  ON social_data FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own data
CREATE POLICY "Users can update own social data"
  ON social_data FOR UPDATE
  USING (auth.uid() = user_id);

-- Policy: Users can delete their own data
CREATE POLICY "Users can delete own social data"
  ON social_data FOR DELETE
  USING (auth.uid() = user_id);
```

## Environment Variables

Add these to your `.env` file:

```env
# Pinterest API
PINTEREST_CLIENT_ID=your_pinterest_client_id
PINTEREST_CLIENT_SECRET=your_pinterest_client_secret

# Instagram API
INSTAGRAM_CLIENT_ID=your_instagram_client_id
INSTAGRAM_CLIENT_SECRET=your_instagram_client_secret
```

## Setup Instructions

1. **Create the tables in Supabase:**
   - Go to your Supabase dashboard
   - Navigate to SQL Editor
   - Run the SQL statements above

2. **Get API credentials:**
   - **Pinterest**: https://developers.pinterest.com/
   - **Instagram**: https://developers.facebook.com/docs/instagram-basic-display-api

3. **Configure OAuth redirect URIs:**
   - Pinterest: `http://localhost:3001/api/social/callback/pinterest`
   - Instagram: `http://localhost:3001/api/social/callback/instagram`
   - For production, update these to your production domain

## Security Notes

- **Encrypt tokens**: In production, encrypt `access_token` and `refresh_token` before storing
- **Token rotation**: Implement automatic token refresh before expiration
- **Rate limiting**: Respect API rate limits when syncing data
- **Data retention**: Consider implementing data retention policies for old synced content

