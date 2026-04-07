import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  gitlab_path: text('gitlab_path').notNull().unique(),
  project_id: text('project_id'),
  enabled: integer('enabled').default(1),
  added_at: text('added_at'),
});

export const releases = sqliteTable('releases', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  branch_name: text('branch_name').notNull(),
  status: text('status').default('active'),
  created_at: text('created_at'),
  completed_at: text('completed_at'),
});

export const releaseRepos = sqliteTable('release_repos', {
  id: text('id').primaryKey(),
  release_id: text('release_id').notNull(),
  repo_id: text('repo_id').notNull(),
  deploy_status: text('deploy_status').default('deploy'),
  risk_level: text('risk_level').default('low'),
  notes: text('notes'),
});

export const releaseDocuments = sqliteTable('release_documents', {
  id: text('id').primaryKey(),
  release_id: text('release_id').notNull().unique(),
  content: text('content').notNull(),
  generated_at: text('generated_at'),
  updated_at: text('updated_at'),
});
