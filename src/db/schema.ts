import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const branches = sqliteTable('branches', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').default('active'),
  created_by: text('created_by'),
  created_at: text('created_at'),
});

export const hotfixes = sqliteTable('hotfixes', {
  id: text('id').primaryKey(),
  branch_id: text('branch_id'),
  pr_url: text('pr_url'),
  author: text('author'),
  developer: text('developer'),
  ticket_id: text('ticket_id'),
  merged_at: text('merged_at'),
});

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull()
});

export const cleanupLogs = sqliteTable('cleanup_logs', {
  id: text('id').primaryKey(),
  executed_at: text('executed_at'),
  branches_deleted: integer('branches_deleted')
});
