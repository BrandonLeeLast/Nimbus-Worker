import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const cleanupLogs = sqliteTable('cleanup_logs', {
  id: text('id').primaryKey(),
  executed_at: text('executed_at'),
  branches_deleted: integer('branches_deleted')
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  role: text('role').default('user'), // 'admin', 'user'
  must_reset_password: integer('must_reset_password').default(1), // 1 = true
  created_at: text('created_at')
});

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const releases = sqliteTable('releases', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(), // e.g. release-20260330
  status: text('status').default('active'), // active, completed
  created_by: text('created_by'),
  created_at: text('created_at'),
});

export const releaseDocuments = sqliteTable('release_documents', {
  id: text('id').primaryKey(),
  release_id: text('release_id').notNull(),
  content: text('content'), // JSON or Markdown
  generated_at: text('generated_at'),
});
