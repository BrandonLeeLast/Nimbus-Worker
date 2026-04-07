-- Migration: 0001_initial_schema
-- Nimbus release management - no auth

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gitlab_path TEXT NOT NULL UNIQUE,
  project_id TEXT,
  enabled INTEGER DEFAULT 1,
  added_at TEXT
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  branch_name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS release_repos (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  deploy_status TEXT DEFAULT 'deploy',
  risk_level TEXT DEFAULT 'low',
  notes TEXT,
  UNIQUE(release_id, repo_id)
);

CREATE TABLE IF NOT EXISTS release_documents (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  generated_at TEXT,
  updated_at TEXT
);
