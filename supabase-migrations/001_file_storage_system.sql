-- ============================================
-- File Storage & AI Workspace System
-- Migration: 001_file_storage_system.sql
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- WORKSPACES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL DEFAULT 'My Workspace',
  settings JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(owner_id) -- One workspace per user (can be changed later)
);

-- ============================================
-- FOLDERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE NOT NULL,
  parent_folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL, -- Full path like "Documents/Projects/"
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(workspace_id, path) -- Unique path per workspace
);

-- ============================================
-- FILES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE NOT NULL,
  folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  
  -- File metadata
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_type TEXT NOT NULL, -- pdf, image, video, doc, etc.
  mime_type TEXT,
  size BIGINT NOT NULL, -- Size in bytes
  
  -- Storage
  storage_bucket TEXT DEFAULT 'user-files',
  storage_path TEXT NOT NULL, -- Path in Supabase Storage
  file_url TEXT, -- Public/private URL
  thumbnail_url TEXT, -- For images/videos
  
  -- Content extraction
  extracted_text TEXT, -- Full extracted text content
  text_chunks JSONB, -- Array of text chunks for embedding
  processing_status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
  processing_error TEXT,
  
  -- AI metadata
  auto_tags TEXT[], -- AI-generated tags
  suggested_folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  summary TEXT, -- AI-generated summary
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb, -- Additional metadata (dimensions, duration, etc.)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Indexes
  CONSTRAINT valid_processing_status CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed'))
);

-- ============================================
-- EMBEDDINGS TABLE (Vector Storage)
-- ============================================
CREATE TABLE IF NOT EXISTS file_embeddings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID REFERENCES files(id) ON DELETE CASCADE NOT NULL,
  chunk_index INTEGER NOT NULL, -- Index of chunk in text_chunks array
  chunk_text TEXT NOT NULL,
  embedding vector(1536), -- OpenAI ada-002 dimension (adjust if using different model)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(file_id, chunk_index)
);

-- ============================================
-- CHAT QUERIES TABLE (Optional logging)
-- ============================================
CREATE TABLE IF NOT EXISTS chat_queries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  query_text TEXT NOT NULL,
  query_embedding vector(1536), -- Embedding of the query
  retrieved_file_ids UUID[], -- Files that were retrieved
  response_text TEXT, -- AI response
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- INDEXES for Performance
-- ============================================

-- Workspaces
CREATE INDEX idx_workspaces_owner_id ON workspaces(owner_id);

-- Folders
CREATE INDEX idx_folders_workspace_id ON folders(workspace_id);
CREATE INDEX idx_folders_parent_id ON folders(parent_folder_id);
CREATE INDEX idx_folders_path ON folders(workspace_id, path);

-- Files
CREATE INDEX idx_files_workspace_id ON files(workspace_id);
CREATE INDEX idx_files_folder_id ON files(folder_id);
CREATE INDEX idx_files_file_type ON files(file_type);
CREATE INDEX idx_files_processing_status ON files(processing_status);
CREATE INDEX idx_files_created_at ON files(created_at DESC);
CREATE INDEX idx_files_auto_tags ON files USING GIN(auto_tags); -- GIN index for array search

-- Embeddings - Vector similarity search
CREATE INDEX idx_file_embeddings_file_id ON file_embeddings(file_id);
CREATE INDEX idx_file_embeddings_vector ON file_embeddings 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100); -- For similarity search

-- Chat queries
CREATE INDEX idx_chat_queries_workspace_id ON chat_queries(workspace_id);
CREATE INDEX idx_chat_queries_user_id ON chat_queries(user_id);
CREATE INDEX idx_chat_queries_created_at ON chat_queries(created_at DESC);

-- ============================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================

-- Enable RLS on all tables
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_queries ENABLE ROW LEVEL SECURITY;

-- Workspaces: Users can only access their own workspace
CREATE POLICY "Users can view own workspace" ON workspaces
  FOR SELECT USING (auth.uid() = owner_id);

CREATE POLICY "Users can insert own workspace" ON workspaces
  FOR INSERT WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can update own workspace" ON workspaces
  FOR UPDATE USING (auth.uid() = owner_id);

CREATE POLICY "Users can delete own workspace" ON workspaces
  FOR DELETE USING (auth.uid() = owner_id);

-- Folders: Users can only access folders in their workspace
CREATE POLICY "Users can view own workspace folders" ON folders
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM workspaces 
      WHERE workspaces.id = folders.workspace_id 
      AND workspaces.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own workspace folders" ON folders
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces 
      WHERE workspaces.id = folders.workspace_id 
      AND workspaces.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own workspace folders" ON folders
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM workspaces 
      WHERE workspaces.id = folders.workspace_id 
      AND workspaces.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own workspace folders" ON folders
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM workspaces 
      WHERE workspaces.id = folders.workspace_id 
      AND workspaces.owner_id = auth.uid()
    )
  );

-- Files: Users can only access files in their workspace
CREATE POLICY "Users can view own workspace files" ON files
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM workspaces 
      WHERE workspaces.id = files.workspace_id 
      AND workspaces.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own workspace files" ON files
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces 
      WHERE workspaces.id = files.workspace_id 
      AND workspaces.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own workspace files" ON files
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM workspaces 
      WHERE workspaces.id = files.workspace_id 
      AND workspaces.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own workspace files" ON files
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM workspaces 
      WHERE workspaces.id = files.workspace_id 
      AND workspaces.owner_id = auth.uid()
    )
  );

-- File Embeddings: Users can only access embeddings for their files
CREATE POLICY "Users can view own file embeddings" ON file_embeddings
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM files
      JOIN workspaces ON workspaces.id = files.workspace_id
      WHERE files.id = file_embeddings.file_id
      AND workspaces.owner_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own file embeddings" ON file_embeddings
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM files
      JOIN workspaces ON workspaces.id = files.workspace_id
      WHERE files.id = file_embeddings.file_id
      AND workspaces.owner_id = auth.uid()
    )
  );

-- Chat Queries: Users can only access their own queries
CREATE POLICY "Users can view own chat queries" ON chat_queries
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own chat queries" ON chat_queries
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Function to automatically create workspace for new users
-- Uses EXCEPTION handler so a failure here never blocks user creation
CREATE OR REPLACE FUNCTION create_workspace_for_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO workspaces (owner_id, name)
  VALUES (NEW.id, 'My Workspace')
  ON CONFLICT (owner_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not auto-create workspace for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create workspace when user signs up
-- NOTE: If this trigger fails, the get_user_workspace() function handles lazy creation
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_workspace_for_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_folders_updated_at
  BEFORE UPDATE ON folders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_files_updated_at
  BEFORE UPDATE ON files
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to get or create user's workspace
CREATE OR REPLACE FUNCTION get_user_workspace()
RETURNS UUID AS $$
DECLARE
  workspace_id UUID;
BEGIN
  SELECT id INTO workspace_id
  FROM workspaces
  WHERE owner_id = auth.uid()
  LIMIT 1;
  
  IF workspace_id IS NULL THEN
    INSERT INTO workspaces (owner_id, name)
    VALUES (auth.uid(), 'My Workspace')
    RETURNING id INTO workspace_id;
  END IF;
  
  RETURN workspace_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to search files by vector similarity
CREATE OR REPLACE FUNCTION search_files_by_embedding(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  workspace_uuid UUID DEFAULT NULL
)
RETURNS TABLE (
  file_id UUID,
  chunk_text TEXT,
  similarity float,
  filename TEXT,
  file_type TEXT,
  file_url TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    fe.file_id,
    fe.chunk_text,
    1 - (fe.embedding <=> query_embedding) as similarity,
    f.filename,
    f.file_type,
    f.file_url
  FROM file_embeddings fe
  JOIN files f ON f.id = fe.file_id
  WHERE 
    (workspace_uuid IS NULL OR f.workspace_id = workspace_uuid)
    AND f.processing_status = 'completed'
    AND 1 - (fe.embedding <=> query_embedding) > match_threshold
  ORDER BY fe.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
