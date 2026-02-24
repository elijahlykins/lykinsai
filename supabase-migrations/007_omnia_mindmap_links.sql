-- ============================================
-- Omnia Mindmap Links
-- Migration: 007_omnia_mindmap_links.sql
-- ============================================

-- Ensure UUID extension exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- MINDMAP LINKS
-- ============================================
CREATE TABLE IF NOT EXISTS omnia_mindmap_links (
  id TEXT PRIMARY KEY,
  mindmap_id UUID REFERENCES omnia_project_mindmaps(id) ON DELETE CASCADE NOT NULL,
  from_id UUID REFERENCES omnia_mindmap_nodes(id) ON DELETE CASCADE NOT NULL,
  to_id UUID REFERENCES omnia_mindmap_nodes(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_omnia_mindmap_links_mindmap_id ON omnia_mindmap_links(mindmap_id);
CREATE INDEX IF NOT EXISTS idx_omnia_mindmap_links_from_id ON omnia_mindmap_links(from_id);
CREATE INDEX IF NOT EXISTS idx_omnia_mindmap_links_to_id ON omnia_mindmap_links(to_id);

-- ============================================
-- Row Level Security
-- ============================================
ALTER TABLE omnia_mindmap_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own mindmap links"
  ON omnia_mindmap_links FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM omnia_project_mindmaps mm
    JOIN omnia_projects p ON p.id = mm.project_id
    WHERE mm.id = mindmap_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert own mindmap links"
  ON omnia_mindmap_links FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM omnia_project_mindmaps mm
    JOIN omnia_projects p ON p.id = mm.project_id
    WHERE mm.id = mindmap_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can update own mindmap links"
  ON omnia_mindmap_links FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM omnia_project_mindmaps mm
    JOIN omnia_projects p ON p.id = mm.project_id
    WHERE mm.id = mindmap_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete own mindmap links"
  ON omnia_mindmap_links FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM omnia_project_mindmaps mm
    JOIN omnia_projects p ON p.id = mm.project_id
    WHERE mm.id = mindmap_id AND p.user_id = auth.uid()
  ));
