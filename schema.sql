DROP TABLE IF EXISTS branches;
CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS hotfixes;
CREATE TABLE hotfixes (
  id TEXT PRIMARY KEY,
  branch_id TEXT,
  pr_url TEXT,
  author TEXT,
  developer TEXT,
  ticket_id TEXT,
  merged_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS repositories;
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL
);

DROP TABLE IF EXISTS cleanup_logs;
CREATE TABLE cleanup_logs (
  id TEXT PRIMARY KEY,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  branches_deleted INTEGER
);
