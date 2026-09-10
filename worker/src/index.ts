interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_API_TOKEN?: string;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_WORKFLOW_REF?: string;
  GITHUB_DISPATCH_DISABLED?: string;
}

interface Article {
  id: string;
  title: string;
  link: string;
  source: string;
  category?: string;
  signal_score?: number;
  summary?: string;
  summary_source?: string;
  published?: string | null;
  first_seen?: string | null;
  timestamp?: string | null;
  [key: string]: unknown;
}

interface Dashboard {
  publication_id: string;
  generated_at: string;
  articles: Article[];
  stats: Record<string, unknown>;
  sources: Record<string, unknown>;
}

interface DocumentRow {
  body_text: string;
  content_type: string;
  etag: string;
  byte_count: number;
}

interface SourceRow {
  id: string;
  name: string;
  config_json: string;
  revision: number;
  updated_at: string;
}

interface ToolJobRow {
  id: string;
  kind: string;
  state: string;
  result_json: string | null;
  error: string | null;
  requested_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  expires_at: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ALLOWED_SORTS = new Set(['score', 'recent', 'mixed', 'source', 'category']);
// Compatibility reads the publisher can prepare in full, so the Worker returns
// stored text instead of parsing the dashboard document.
const PREPARED_READS: Record<string, string> = {
  '/api/stats': 'stats',
  '/api/sources': 'sources',
};
const CATEGORY_ORDER = [
  'Security', 'Policy & Regulation', 'Funding & M&A', 'Chips & Hardware',
  'Crypto & Fintech', 'Science & Space', 'AI Research', 'Models & Releases',
  'AI Tools & Agents', 'Engineering & Open Source', 'Big Tech',
  'Business & Markets', 'Other',
];

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/admin/')) {
      return await adminRoute(request, env, url);
    }
    if (request.method !== 'GET' && !(request.method === 'POST' && url.pathname === '/api/refresh')) {
      return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
    }

    try {
      // Status reads answer from publication metadata and the small stats
      // document. Parsing the whole dashboard here cost 7-15 ms of the 10 ms
      // Free-plan CPU budget once the feed grew past a few hundred articles.
      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        const summary = await activeSummary(env);
        return json({
          status: 'checked',
          message: 'Checked the latest saved feed. Sources are checked on a 30-minute schedule.',
          publication_id: summary.publication_id,
        });
      }
      if (url.pathname === '/api/refresh/status') {
        const summary = await activeSummary(env);
        return json({ state: 'idle', count: summary.count,
          publication_id: summary.publication_id });
      }
      if (url.pathname === '/api/health') {
        const summary = await activeSummary(env);
        const age = Math.max(0, (Date.now() - Date.parse(summary.generated_at)) / 1000);
        return json({ status: age > 3600 ? 'degraded' : 'ok', storage_error: null,
          articles: summary.count, age_seconds: age, stale: age > 3600,
          publication_id: summary.publication_id });
      }
      return await cachedRead(request, context, () => readRoute(request, env, url));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return json({ error: 'Published feed is unavailable. Please retry shortly.' }, 503);
    }
  },
};

async function adminRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (!await isAuthorized(request, env)) {
    return json({ error: 'Owner authorization required' }, 401, {
      'www-authenticate': 'Bearer realm="High Signal owner"',
    });
  }

  try {
    if (url.pathname === '/api/admin/sources' && request.method === 'GET') {
      return json({ sources: await authoritativeSources(env) }, 200,
        { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/admin/sources' && request.method === 'POST') {
      const payload = await jsonBody(request);
      const source = validateSource(payload);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO sources (id, name, config_json, revision, updated_at, deleted_at)
           VALUES (?, ?, ?, 1, ?, NULL)`,
        ).bind(id, source.name, JSON.stringify(source), now).run();
      } catch (error) {
        if (String(error).toLowerCase().includes('unique')) {
          return json({ error: 'A source with that name already exists' }, 409);
        }
        throw error;
      }
      return json({ status: 'created', source: { ...source, id, revision: 1,
        updated_at: now } }, 201, { 'cache-control': 'no-store' });
    }

    const sourceMatch = url.pathname.match(/^\/api\/admin\/sources\/([^/]+)$/);
    if (sourceMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
      const id = decodeURIComponent(sourceMatch[1]);
      const payload = await jsonBody(request);
      const revision = positiveInteger(payload.revision, 'A source revision is required');
      const saved = await env.DB.prepare(
        `SELECT id, name, config_json, revision, updated_at FROM sources
         WHERE id = ? AND deleted_at IS NULL`,
      ).bind(id).first<SourceRow>();
      if (!saved) return json({ error: 'No such source' }, 404);
      if (saved.revision !== revision) {
        return json({ error: 'Source changed since it was loaded', current_revision: saved.revision }, 409);
      }
      const now = new Date().toISOString();
      if (request.method === 'DELETE') {
        const result = await env.DB.prepare(
          `UPDATE sources SET deleted_at = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        ).bind(now, now, id, revision).run();
        if (result.meta.changes !== 1) return await sourceConflict(env, id);
        return json({ status: 'deleted', id, name: saved.name });
      }

      const existing = JSON.parse(saved.config_json) as Record<string, unknown>;
      const changes = payload.changes && typeof payload.changes === 'object'
        ? payload.changes as Record<string, unknown> : payload;
      const source = validateSource({ ...existing, ...changes });
      const result = await env.DB.prepare(
        `UPDATE sources SET name = ?, config_json = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      ).bind(source.name, JSON.stringify(source), now, id, revision).run();
      if (result.meta.changes !== 1) return await sourceConflict(env, id);
      return json({ status: 'updated', source: { ...source, id,
        revision: revision + 1, updated_at: now } });
    }

    if (url.pathname === '/api/admin/jobs' && request.method === 'POST') {
      return await createToolJob(request, env);
    }
    const jobMatch = url.pathname.match(/^\/api\/admin\/jobs\/([a-f0-9-]+)$/);
    if (jobMatch && request.method === 'GET') return await getToolJob(env, jobMatch[1]);
    const retryMatch = url.pathname.match(/^\/api\/admin\/jobs\/([a-f0-9-]+)\/retry$/);
    if (retryMatch && request.method === 'POST') return await retryToolJob(env, retryMatch[1]);

    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    console.error(error instanceof Error ? error.message : error);
    return json({ error: 'Owner request failed' }, 500);
  }
}

async function authoritativeSources(env: Env): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare(
    `SELECT id, name, config_json, revision, updated_at FROM sources
     WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
  ).all<SourceRow>();
  return result.results.map((row) => {
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    return { ...config, id: row.id, revision: row.revision, updated_at: row.updated_at };
  });
}

async function sourceConflict(env: Env, id: string): Promise<Response> {
  const current = await env.DB.prepare(
    'SELECT revision FROM sources WHERE id = ? AND deleted_at IS NULL',
  ).bind(id).first<{ revision: number }>();
  return json({ error: 'Source changed since it was loaded',
    current_revision: current?.revision ?? null }, 409);
}

async function createToolJob(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  const kind = body.kind;
  if (kind !== 'discover' && kind !== 'test') {
    throw new RequestError(400, 'Job kind must be discover or test');
  }
  const payload = validateSourceToolPayload(kind, body.payload);
  const payloadJson = stableJson(payload);
  if (new TextEncoder().encode(payloadJson).byteLength > 16_384) {
    throw new RequestError(413, 'Source-tool payload is too large');
  }
  const idempotencyKey = await sha256(kind + ':' + payloadJson);
  const duplicate = await env.DB.prepare(
    `SELECT id, kind, state, result_json, error, requested_at, claimed_at, finished_at, expires_at
     FROM tool_jobs WHERE idempotency_key = ? AND state IN ('queued', 'running')
     ORDER BY requested_at DESC LIMIT 1`,
  ).bind(idempotencyKey).first<ToolJobRow>();
  if (duplicate) return json(jobPayload(duplicate), 202, { 'cache-control': 'no-store' });

  const now = new Date();
  const requestedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const id = crypto.randomUUID();
  let inserted: D1Result;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO tool_jobs
       (id, kind, payload_json, state, requested_at, expires_at, idempotency_key)
       SELECT ?, ?, ?, 'queued', ?, ?, ?
       WHERE (SELECT COUNT(*) FROM tool_jobs WHERE requested_at >= ? AND requested_at < ?) < 20`,
    ).bind(id, kind, payloadJson, requestedAt, expiresAt, idempotencyKey,
      dayStart.toISOString(), dayEnd.toISOString()).run();
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) {
      const raced = await env.DB.prepare(
        `SELECT id, kind, state, result_json, error, requested_at, claimed_at, finished_at, expires_at
         FROM tool_jobs WHERE idempotency_key = ? AND state IN ('queued', 'running') LIMIT 1`,
      ).bind(idempotencyKey).first<ToolJobRow>();
      if (raced) return json(jobPayload(raced), 202, { 'cache-control': 'no-store' });
    }
    throw error;
  }
  if (inserted.meta.changes !== 1) {
    return json({ error: 'Daily source-tool limit reached (20 jobs)' }, 429);
  }

  const dispatch = await dispatchToolJob(env, id);
  if (!dispatch.ok) {
    await env.DB.prepare(
      `UPDATE tool_jobs SET state = 'failed', error = ?, finished_at = ?
       WHERE id = ? AND state = 'queued'`,
    ).bind(dispatch.error.slice(0, 300), new Date().toISOString(), id).run();
    return json({ id, kind, state: 'failed', error: dispatch.error }, 502,
      { 'cache-control': 'no-store' });
  }
  return json({ id, kind, state: 'queued', requested_at: requestedAt,
    expires_at: expiresAt, dispatched: dispatch.dispatched }, 202,
  { 'cache-control': 'no-store' });
}

async function getToolJob(env: Env, id: string): Promise<Response> {
  const job = await env.DB.prepare(
    `SELECT id, kind, state, result_json, error, requested_at, claimed_at, finished_at, expires_at
     FROM tool_jobs WHERE id = ?`,
  ).bind(id).first<ToolJobRow>();
  if (!job) return json({ error: 'No such job' }, 404);
  if (Date.parse(job.expires_at) <= Date.now()) return json({ error: 'Job result expired' }, 410);
  return json(jobPayload(job), 200, { 'cache-control': 'no-store' });
}

async function retryToolJob(env: Env, id: string): Promise<Response> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE tool_jobs SET state = 'queued', error = NULL, claimed_at = NULL, finished_at = NULL
     WHERE id = ? AND state = 'failed' AND expires_at > ?`,
  ).bind(id, now).run();
  if (result.meta.changes !== 1) {
    return json({ error: 'Only an unexpired failed job can be retried' }, 409);
  }
  const dispatch = await dispatchToolJob(env, id);
  if (!dispatch.ok) {
    await env.DB.prepare(
      `UPDATE tool_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`,
    ).bind(dispatch.error.slice(0, 300), new Date().toISOString(), id).run();
    return json({ id, state: 'failed', error: dispatch.error }, 502);
  }
  return json({ id, state: 'queued', dispatched: dispatch.dispatched }, 202);
}

async function dispatchToolJob(env: Env, id: string): Promise<{
  ok: boolean; dispatched: boolean; error: string;
}> {
  if (env.GITHUB_DISPATCH_DISABLED === '1') {
    return { ok: true, dispatched: false, error: '' };
  }
  if (!env.GITHUB_ACTIONS_TOKEN || !env.GITHUB_REPOSITORY) {
    return { ok: false, dispatched: false,
      error: 'GitHub Actions dispatch is not configured' };
  }
  const endpoint = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}` +
    '/actions/workflows/source-tools.yml/dispatches';
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'high-signal-worker',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref: env.GITHUB_WORKFLOW_REF || 'main', inputs: { job_id: id } }),
    });
  } catch {
    return { ok: false, dispatched: false, error: 'GitHub dispatch network error' };
  }
  if (response.status !== 204) {
    return { ok: false, dispatched: false, error: `GitHub dispatch failed (HTTP ${response.status})` };
  }
  return { ok: true, dispatched: true, error: '' };
}

function jobPayload(row: ToolJobRow): Record<string, unknown> {
  let result: unknown = null;
  if (row.result_json) {
    try { result = JSON.parse(row.result_json); } catch { result = null; }
  }
  return { id: row.id, kind: row.kind, state: row.state, result, error: row.error,
    requested_at: row.requested_at, claimed_at: row.claimed_at,
    finished_at: row.finished_at, expires_at: row.expires_at };
}

function validateSourceToolPayload(kind: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'A source configuration is required');
  }
  const payload = value as Record<string, unknown>;
  if (kind === 'discover') {
    return validateSource({ ...payload,
      name: cleanString(payload.name, 80) || 'Preview' });
  }
  return validateSource({ ...payload, name: cleanString(payload.name, 80) || 'Preview' });
}

export function validateSource(value: unknown): Record<string, unknown> & { name: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'A source configuration is required');
  }
  const input = value as Record<string, unknown>;
  const name = cleanString(input.name, 80);
  if (!name) throw new RequestError(400, 'A name is required');
  const type = cleanString(input.type, 12).toLowerCase() || 'static';
  if (!['static', 'rss', 'json'].includes(type)) {
    throw new RequestError(400, 'Type must be static, rss or json');
  }
  const source: Record<string, unknown> & { name: string } = {
    name,
    url: validatePublicUrl(input.url, 'URL'),
    tier: validateTier(input.tier),
    category: cleanString(input.category, 80) || 'Other',
    type,
    limit: input.limit == null || input.limit === '' ? 15
      : positiveInteger(input.limit, 'Limit must be a number', 50),
    retries: input.retries == null || input.retries === '' ? 3
      : positiveInteger(input.retries, 'Retries must be a number', 3),
    retention_hours: boundedInteger(input.retention_hours, 'Retention hours', 72, 0, 168),
    enabled: booleanValue(input.enabled, 'enabled', true),
    allow_empty: booleanValue(input.allow_empty, 'allow_empty', false),
  };
  if (input.lock_category != null) {
    source.lock_category = booleanValue(input.lock_category, 'lock_category', false);
  }
  const feedUrl = cleanString(input.feed_url, 2048);
  if (feedUrl) source.feed_url = validatePublicUrl(feedUrl, 'Feed URL');
  if (type === 'static') {
    source.selector = cleanString(input.selector, 500) || 'h2 a, h3 a';
    const fallback = cleanString(input.fallback, 500);
    if (fallback) source.fallback = fallback;
  }
  const allowedHosts = stringList(input.allowed_hosts, 'allowed_hosts', 12);
  const pathPrefixes = stringList(input.path_prefixes, 'path_prefixes', 12);
  if (allowedHosts.length) source.allowed_hosts = allowedHosts;
  if (pathPrefixes.length) source.path_prefixes = pathPrefixes;
  if (input.fetch_strategies != null) {
    if (!Array.isArray(input.fetch_strategies) || input.fetch_strategies.length < 1 ||
        input.fetch_strategies.length > 4) {
      throw new RequestError(400, 'fetch_strategies must contain 1 to 4 strategies');
    }
    const ids = new Set<string>();
    source.fetch_strategies = input.fetch_strategies.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new RequestError(400, 'Each fetch strategy must be an object');
      }
      const item = raw as Record<string, unknown>;
      const strategyType = cleanString(item.type, 12).toLowerCase() || 'static';
      if (!['static', 'rss', 'json'].includes(strategyType)) {
        throw new RequestError(400, 'Strategy type must be static, rss or json');
      }
      const id = cleanString(item.id, 50) || `strategy-${index + 1}`;
      if (ids.has(id.toLowerCase())) {
        throw new RequestError(400, 'Fetch strategy ids must be unique');
      }
      ids.add(id.toLowerCase());
      const strategy: Record<string, unknown> = {
        id, type: strategyType,
        url: validatePublicUrl(item.url || source.url, 'Strategy URL'),
      };
      if (strategyType === 'static') {
        const selectors = stringList(item.selectors, 'Strategy selectors', 20);
        strategy.selectors = selectors.length
          ? selectors : [cleanString(item.selector, 500) || 'h2 a, h3 a'];
      }
      return strategy;
    });
  }
  return source;
}

function boundedInteger(value: unknown, label: string, fallback: number,
                        minimum: number, maximum: number): number {
  if (value == null || value === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new RequestError(400, `${label} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

function stringList(value: unknown, label: string, maximum: number): string[] {
  if (value == null || value === '') return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RequestError(400, `${label} must be a list of at most ${maximum} strings`);
  }
  return value.map((item) => {
    const text = cleanString(item, 500);
    if (!text) throw new RequestError(400, `${label} contains an invalid value`);
    return text;
  });
}

function validateTier(value: unknown): string {
  const tier = cleanString(value, 12).toLowerCase() || 'medium';
  if (!['high', 'medium', 'low'].includes(tier)) {
    throw new RequestError(400, 'Tier must be high, medium or low');
  }
  return tier;
}

export function validatePublicUrl(value: unknown, label: string): string {
  const text = cleanString(value, 2048);
  let url: URL;
  try { url = new URL(text); } catch { throw new RequestError(400, `${label} is invalid`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== '80' && url.port !== '443')) {
    throw new RequestError(400, `${label} must be a public HTTP URL`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === 'metadata.google.internal' || host.includes(':') || privateIp(host)) {
    throw new RequestError(400, `${label} points at a local or private address`);
  }
  return url.toString();
}

function privateIp(host: string): boolean {
  if (host === '::1' || host === '::' || host.startsWith('fe80:') ||
      host.startsWith('fc') || host.startsWith('fd')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!supplied || !env.ADMIN_API_TOKEN) return false;
  const [left, right] = await Promise.all([sha256(supplied), sha256(env.ADMIN_API_TOKEN)]);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort().map((key) =>
      JSON.stringify(key) + ':' + stableJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 32_768) throw new RequestError(413, 'Request body is too large');
  let body: unknown;
  try { body = await request.json(); } catch { throw new RequestError(400, 'Valid JSON is required'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'A JSON object is required');
  }
  return body as Record<string, unknown>;
}

function positiveInteger(value: unknown, message: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RequestError(400, message);
  return Math.min(number, maximum);
}

function cleanString(value: unknown, maximum: number): string {
  return String(value ?? '').trim().slice(0, maximum);
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw new RequestError(400, `${label} must be true or false`);
  return value;
}

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function compatibilityRoute(url: URL, env: Env): Promise<Response> {
  const dashboard = await loadDashboard(env);
  const cacheable = (payload: unknown) => derived(dashboard, url, payload);
  if (url.pathname === '/api/stats') return cacheable(dashboard.stats);
  if (url.pathname === '/api/sources') return cacheable(dashboard.sources);
  if (url.pathname === '/api/feed') return cacheable(filterAndSort(dashboard.articles, url));
  if (url.pathname === '/api/articles') {
    const items = filterAndSort(dashboard.articles, url, false);
    return cacheable(items.slice(0, integer(url, 'limit', 50, 0, 1000)));
  }
  if (url.pathname === '/api/high_signal') {
    return cacheable(dashboard.articles.filter((article) => score(article) >= 75).slice(0, 30));
  }
  if (url.pathname === '/api/grouped') return cacheable(groupBySource(dashboard.articles, url));
  if (url.pathname === '/api/categories') return cacheable(groupByCategory(dashboard.articles, url));
  const summary = url.pathname.match(/^\/api\/article\/([^/]+)\/summary$/);
  if (summary) return articleSummary(dashboard, url, decodeURIComponent(summary[1]));
  if (url.pathname === '/feed.xml') {
    return new Response(buildRss(dashboard, url), {
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'cache-control': 'public, max-age=60, s-maxage=120',
        etag: derivedEtag(dashboard.publication_id, url),
      },
    });
  }
  return json({ error: 'Not found' }, 404);
}

// A derived response is identified by the publication it came from and the
// query that shaped it, so revalidation never re-reads the feed document.
function derived(dashboard: Dashboard, url: URL, payload: unknown): Response {
  return json(payload, 200, {
    'cache-control': 'public, max-age=60, s-maxage=120',
    etag: derivedEtag(dashboard.publication_id, url),
  });
}

export function derivedEtag(publicationId: string, url: URL): string {
  const parameters = [...url.searchParams.entries()].sort();
  const shape = url.pathname + '?' + new URLSearchParams(parameters).toString();
  let hash = 0x811c9dc5;
  for (let index = 0; index < shape.length; index += 1) {
    hash = Math.imul(hash ^ shape.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `"${publicationId}-${hash.toString(16)}"`;
}

async function activeDocument(env: Env, key: string,
  optional: true): Promise<DocumentRow | null>;
async function activeDocument(env: Env, key: string): Promise<DocumentRow>;
async function activeDocument(env: Env, key: string,
  optional = false): Promise<DocumentRow | null> {
  const row = await env.DB.prepare(
    `SELECT d.body_text, d.content_type, d.etag, d.byte_count
       FROM app_state s
       JOIN publications p ON p.id = s.value AND p.ready = 1
       JOIN publication_documents d ON d.publication_id = p.id
      WHERE s.key = 'active_publication_id' AND d.key = ?`,
  ).bind(key).first<DocumentRow>();
  if (!row) {
    if (optional) return null;
    throw new Error(`No active ${key} document`);
  }
  return row;
}

function documentResponse(document: DocumentRow,
  extraHeaders: Record<string, string> = {}): Response {
  return new Response(document.body_text, { headers: {
    'content-type': document.content_type,
    'content-length': String(document.byte_count),
    'cache-control': 'public, max-age=60, s-maxage=120',
    etag: `"${document.etag}"`,
    ...extraHeaders,
  } });
}

// Identity, freshness and article count without reading a document body.
async function activeSummary(env: Env): Promise<{
  publication_id: string; generated_at: string; count: number;
}> {
  const meta = await env.DB.prepare(
    `SELECT p.id, p.generated_at
       FROM app_state s
       JOIN publications p ON p.id = s.value AND p.ready = 1
      WHERE s.key = 'active_publication_id'`,
  ).first<{ id: string; generated_at: string }>();
  if (meta) {
    const stats = await activeDocument(env, 'stats', true);
    if (stats) {
      const parsed = JSON.parse(stats.body_text) as { total_articles?: unknown };
      return { publication_id: meta.id, generated_at: meta.generated_at,
        count: Number(parsed.total_articles) || 0 };
    }
  }
  const dashboard = await loadDashboard(env);
  return { publication_id: dashboard.publication_id,
    generated_at: dashboard.generated_at, count: dashboard.articles.length };
}

async function loadDashboard(env: Env): Promise<Dashboard> {
  const document = await activeDocument(env, 'dashboard');
  const dashboard = JSON.parse(document.body_text) as Dashboard;
  if (!dashboard.publication_id || !Array.isArray(dashboard.articles)) {
    throw new Error('Active dashboard document is invalid');
  }
  return dashboard;
}

async function storedDocument(request: Request, env: Env, key: string,
  extraHeaders: Record<string, string> = {}): Promise<Response> {
  const document = await activeDocument(env, key);
  const etag = `"${document.etag}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return documentResponse(document, extraHeaders);
}

// Every published read is edge cached by canonical URL. A cache hit costs no
// D1 round trip and no JSON parse, which is what keeps the filtered
// compatibility endpoints inside the Workers Free CPU budget under load.
async function cachedRead(request: Request, context: ExecutionContext,
  build: () => Promise<Response>): Promise<Response> {
  const cacheKey = canonicalCacheKey(request);
  if (!cacheKey) return conditional(request, await build());
  const edgeCache = (caches as unknown as { default: Cache }).default;
  const cached = await edgeCache.match(cacheKey);
  // `x-cache` is the only way to tell a served-from-cache read from a fresh
  // D1 read once the response bodies are identical. Cache entries are
  // per-datacenter, so a miss in another colo is normal.
  if (cached) return conditional(request, marked(cached, 'hit'));
  const response = await build();
  if (response.status === 200 && response.headers.has('cache-control')) {
    context.waitUntil(edgeCache.put(cacheKey, response.clone()));
  }
  return conditional(request, marked(response, 'miss'));
}

// Sorted parameters keep one cache entry per meaningful query rather than one
// per parameter ordering. Static assets keep their own cache path.
export function canonicalCacheKey(request: Request): Request | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/feed.xml') return null;
  const parameters = [...url.searchParams.entries()].sort();
  const search = new URLSearchParams(parameters).toString();
  return new Request(url.origin + url.pathname + (search ? `?${search}` : ''));
}

function marked(response: Response, state: 'hit' | 'miss'): Response {
  const marked = new Response(response.body, response);
  marked.headers.set('x-cache', state);
  return marked;
}

function conditional(request: Request, response: Response): Response {
  const etag = response.headers.get('etag');
  if (etag && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return response;
}

async function readRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/dashboard') {
    return await storedDocument(request, env, 'dashboard');
  }
  if (url.pathname === '/api/export.json') {
    return await storedDocument(request, env, 'export', {
      'content-disposition': 'attachment; filename=high-signal.json',
    });
  }
  if (url.pathname === '/feed.xml' && !url.search) {
    return await storedDocument(request, env, 'rss_default');
  }
  // Publications made before these documents existed fall back to the parsing
  // path below rather than failing.
  const prepared = PREPARED_READS[url.pathname];
  if (prepared) {
    const document = await activeDocument(env, prepared, true);
    if (document) return documentResponse(document);
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/feed.xml') {
    return await compatibilityRoute(url, env);
  }
  return await env.ASSETS.fetch(request);
}

function filterAndSort(input: Article[], url: URL, allowLimit = true): Article[] {
  const minimum = integer(url, 'min_score', 0, 0, 100);
  const source = url.searchParams.get('source') || '';
  const category = url.searchParams.get('category') || '';
  const requestedSort = url.searchParams.get('sort') || 'score';
  const sort = ALLOWED_SORTS.has(requestedSort) ? requestedSort : 'score';
  let articles = input.filter((article) => score(article) >= minimum &&
    (!source || article.source === source) &&
    (!category || articleCategory(article) === category));
  articles = sortArticles(articles, sort);
  const limit = allowLimit ? integer(url, 'limit', 0, 0, 1000) : 0;
  return limit > 0 ? articles.slice(0, limit) : articles;
}

export function sortArticles(input: Article[], sort: string): Article[] {
  const articles = [...input];
  if (sort === 'source') return articles.sort((a, b) =>
    a.source.localeCompare(b.source) || score(b) - score(a));
  if (sort === 'category') return articles.sort((a, b) =>
    categoryRank(articleCategory(a)) - categoryRank(articleCategory(b)) || score(b) - score(a));
  if (sort === 'recent') return articles.sort((a, b) =>
    articleTime(b) - articleTime(a) || score(b) - score(a));
  if (sort === 'mixed') return interleaveBySource(articles);
  return articles.sort((a, b) => score(b) - score(a) || a.source.localeCompare(b.source));
}

function interleaveBySource(input: Article[]): Article[] {
  const buckets = new Map<string, Article[]>();
  [...input].sort((a, b) => score(b) - score(a)).forEach((article) => {
    const bucket = buckets.get(article.source) || [];
    bucket.push(article);
    buckets.set(article.source, bucket);
  });
  const names = [...buckets.keys()].sort((a, b) =>
    score(buckets.get(b)![0]) - score(buckets.get(a)![0]) || a.localeCompare(b));
  const output: Article[] = [];
  const largest = Math.max(0, ...[...buckets.values()].map((items) => items.length));
  for (let index = 0; index < largest; index += 1) {
    names.forEach((name) => { const item = buckets.get(name)![index]; if (item) output.push(item); });
  }
  return output;
}

function groupBySource(input: Article[], url: URL): unknown[] {
  const minimum = integer(url, 'min_score', 0, 0, 100);
  const perSource = integer(url, 'per_source', 100, 1, 1000);
  const groups = new Map<string, Article[]>();
  input.filter((article) => score(article) >= minimum).forEach((article) => {
    const items = groups.get(article.source) || [];
    items.push(article);
    groups.set(article.source, items);
  });
  return [...groups].map(([source, items]) => ({ source, count: items.length,
    articles: sortArticles(items, 'score').slice(0, perSource) }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

function groupByCategory(input: Article[], url: URL): unknown[] {
  const minimum = integer(url, 'min_score', 0, 0, 100);
  const perCategory = integer(url, 'per_category', 100, 1, 1000);
  const groups = new Map<string, Article[]>();
  input.filter((article) => score(article) >= minimum).forEach((article) => {
    const category = articleCategory(article);
    const items = groups.get(category) || [];
    items.push(article);
    groups.set(category, items);
  });
  return [...groups].map(([category, items]) => ({ category, count: items.length,
    sources: new Set(items.map((article) => article.source)).size,
    articles: sortArticles(items, 'score').slice(0, perCategory) }))
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
}

function articleSummary(dashboard: Dashboard, url: URL, id: string): Response {
  const article = dashboard.articles.find((candidate) => candidate.id === id);
  if (!article) return json({ error: 'No such article' }, 404);
  const summary = article.summary || `${article.source}: ${article.title}`;
  return derived(dashboard, url, { id, summary,
    summary_source: article.summary_source || 'metadata',
    cached: Boolean(article.summary) });
}

function buildRss(dashboard: Dashboard, url: URL): string {
  const minimum = integer(url, 'min_score', 60, 0, 100);
  const limit = integer(url, 'limit', 60, 1, 200);
  const items = sortArticles(
    dashboard.articles.filter((article) => score(article) >= minimum), 'recent').slice(0, limit);
  const body = items.map((article) => `<item><title>${xml(article.title)}</title>` +
    `<link>${xml(article.link)}</link><guid isPermaLink="false">${xml(article.id)}</guid>` +
    `<dc:creator>${xml(article.source)}</dc:creator><category>${xml(articleCategory(article))}</category>` +
    `<description>${xml(article.summary || article.title)}</description>` +
    `<pubDate>${new Date(articleTime(article)).toUTCString()}</pubDate></item>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>High Signal</title>' +
    `<link>${xml(url.origin + '/')}</link>` +
    '<description>AI and tech headlines, ranked by signal score.</description>' +
    `<lastBuildDate>${new Date(dashboard.generated_at).toUTCString()}</lastBuildDate>${body}</channel></rss>`;
}

function integer(url: URL, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = url.searchParams.get(key);
  if (value === null || value.trim() === '') return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(raw)));
}

function score(article: Article): number { return Number(article.signal_score) || 0; }
function articleCategory(article: Article): string { return article.category || 'Other'; }
function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index < 0 ? CATEGORY_ORDER.length : index;
}
function articleTime(article: Article): number {
  for (const value of [article.published, article.first_seen, article.timestamp]) {
    if (typeof value === 'string') { const stamp = Date.parse(value); if (Number.isFinite(stamp)) return stamp; }
  }
  return 0;
}
function xml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...headers } });
}
