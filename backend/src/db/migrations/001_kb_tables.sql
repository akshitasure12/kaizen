-- Incremental migration: repository knowledge base (RAG) tables
-- Safe to re-run (IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS kb_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  source_filename VARCHAR(255),
  source_mime_type VARCHAR(100),
  content_ref TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_repo_owner_created
  ON kb_documents(repo_id, owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_documents_status
  ON kb_documents(status);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_document ON kb_chunks(document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_repo_owner ON kb_chunks(repo_id, owner_user_id);

CREATE OR REPLACE FUNCTION update_kb_chunk_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kb_chunk_search_vector_trigger ON kb_chunks;
CREATE TRIGGER kb_chunk_search_vector_trigger
  BEFORE INSERT OR UPDATE ON kb_chunks
  FOR EACH ROW
  EXECUTE FUNCTION update_kb_chunk_search_vector();

CREATE INDEX IF NOT EXISTS idx_kb_chunks_search ON kb_chunks USING gin(search_vector);
