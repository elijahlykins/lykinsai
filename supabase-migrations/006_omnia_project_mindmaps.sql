-- ============================================
-- Omnia Project Mindmaps + Nodes
-- Migration: 006_omnia_project_mindmaps.sql
-- ============================================

-- Ensure UUID extension exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- PROJECT MINDMAPS
-- ============================================
CREATE TABLE IF NOT EXISTS omnia_project_mindmaps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES omnia_projects(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1
);

-- ============================================
-- MINDMAP NODES
-- ============================================
CREATE TABLE IF NOT EXISTS omnia_mindmap_nodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mindmap_id UUID REFERENCES omnia_project_mindmaps(id) ON DELETE CASCADE NOT NULL,
  parent_id UUID REFERENCES omnia_mindmap_nodes(id),
  title TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'topic' CHECK (type IN ('topic', 'goal', 'task', 'asset', 'question', 'decision', 'note')),
  position_x FLOAT,
  position_y FLOAT,
  color TEXT,
  source_type TEXT,
  source_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_omnia_project_mindmaps_project_id ON omnia_project_mindmaps(project_id);
CREATE INDEX IF NOT EXISTS idx_omnia_mindmap_nodes_mindmap_id ON omnia_mindmap_nodes(mindmap_id);
CREATE INDEX IF NOT EXISTS idx_omnia_mindmap_nodes_source ON omnia_mindmap_nodes(source_type, source_id);

-- ============================================
-- Row Level Security
-- ============================================
ALTER TABLE omnia_project_mindmaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE omnia_mindmap_nodes ENABLE ROW LEVEL SECURITY;

-- Project mindmaps policies
CREATE POLICY "Users can view own project mindmaps"
  ON omnia_project_mindmaps FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM omnia_projects p
    WHERE p.id = project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert own project mindmaps"
  ON omnia_project_mindmaps FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM omnia_projects p
    WHERE p.id = project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can update own project mindmaps"
  ON omnia_project_mindmaps FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM omnia_projects p
    WHERE p.id = project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete own project mindmaps"
  ON omnia_project_mindmaps FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM omnia_projects p
    WHERE p.id = project_id AND p.user_id = auth.uid()
  ));

-- Mindmap nodes policies
CREATE POLICY "Users can view own mindmap nodes"
  ON omnia_mindmap_nodes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM omnia_project_mindmaps mm
    JOIN omnia_projects p ON p.id = mm.project_id
    WHERE mm.id = mindmap_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert own mindmap nodes"
  ON omnia_mindmap_nodes FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM omnia_project_mindmaps mm
    JOIN omnia_projects p ON p.id = mm.project_id
    WHERE mm.id = mindmap_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can update own mindmap nodes"
  ON omnia_mindmap_nodes FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM omnia_project_mindmaps mm
    JOIN omnia_projects p ON p.id = mm.project_id
    WHERE mm.id = mindmap_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete own mindmap nodes"
  ON omnia_mindmap_nodes FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM omnia_project_mindmaps mm
    JOIN omnia_projects p ON p.id = mm.project_id
    WHERE mm.id = mindmap_id AND p.user_id = auth.uid()
  ));
