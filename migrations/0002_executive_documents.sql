-- Executive documents table for AI-generated executive summaries
CREATE TABLE IF NOT EXISTS executive_documents (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  generated_at TEXT,
  updated_at TEXT
);
