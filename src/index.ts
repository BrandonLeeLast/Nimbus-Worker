import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { reposCtrl } from './controllers/repos';
import { releasesCtrl } from './controllers/releases';
import { webhooksCtrl } from './controllers/webhooks';
import { settingsCtrl } from './controllers/settings';

export interface Env {
  DB: D1Database;
  NIMBUS_KV: KVNamespace;
  AI: Ai;
  GITLAB_TOKEN: string;
  YOUTRACK_TOKEN: string;
  YOUTRACK_BASE_URL: string;
  DEBUG?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:4173'],
  allowHeaders: ['Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

app.route('/api/repos', reposCtrl);
app.route('/api/releases', releasesCtrl);
app.route('/api/webhooks', webhooksCtrl);
app.route('/api/settings', settingsCtrl);

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
