const { createStore } = require('./store');
async function requireAdmin(req, store) {
  const token = req.headers && (req.headers['x-lc-session'] || req.headers['X-LC-Session']);
  if (!token) { const e = new Error('Unauthorized'); e.statusCode = 401; throw e; }
  const user = await store.findUserBySessionToken(token);
  if (!user) { const e = new Error('Unauthorized'); e.statusCode = 401; throw e; }
}//鉴权

const { verifyPassword, createPasswordHash, createSessionToken } = require('./auth');
const { parseLeanCloudJsonl } = require('./import-jsonl');
const { rowToLeanCloudObject, publicUserFromRow } = require('./leancloud-shape');

const SUPPORTED_CLASSES = new Set(['shuoshuo', 'atComment']);

function normalizeOrigin(origin) {
  return String(origin || '').replace(/\/+$/, '');
}

function allowedOriginForRequest(req) {
  const allowOrigin = process.env.ALLOW_ORIGIN;
  if (!allowOrigin) return '*';

  const requestOrigin = normalizeOrigin(req.headers && (req.headers.origin || req.headers.Origin));
  if (!requestOrigin) return undefined;

  const allowedOrigins = allowOrigin
    .split(',')
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter(Boolean);

  return allowedOrigins.includes(requestOrigin) ? requestOrigin : undefined;
}

function sendJson(req, res, statusCode, body) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const allowedOrigin = allowedOriginForRequest(req);
    if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    if (process.env.ALLOW_ORIGIN) res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LC-Session');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (typeof res.status === 'function') return res.status(statusCode).json(body);
  res.statusCode = statusCode;
  return res.end(JSON.stringify(body));
}

function pathPartsFromUrl(url) {
  if (!url) return [];
  const pathname = new URL(url, 'http://localhost').pathname;
  const prefix = '/api/classes/';
  if (!pathname.startsWith(prefix)) return [];
  return pathname
    .slice(prefix.length)
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
}

function readPathParts(query, url) {
  const path = query.path || query.className || query[0];
  if (Array.isArray(path)) return path;
  if (path) return String(path).split('/').filter(Boolean).map(decodeURIComponent);
  return pathPartsFromUrl(url);
}

function readClassName(query, url) {
  return readPathParts(query, url)[0];
}

function readObjectId(query, url) {
  const path = readPathParts(query, url);
  if (path.length > 1) return path[1];
  return query.objectId;
}

function parseOptions(query) {
  return {
    where: query.where ? JSON.parse(query.where) : {},
    order: query.order,
    limit: query.limit === undefined ? undefined : Number(query.limit),
    skip: query.skip === undefined ? undefined : Number(query.skip)
  };
}

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === 'string') return JSON.parse(body);
  return body;
}

function assertSupportedClass(className) {
  if (!SUPPORTED_CLASSES.has(className)) {
    const error = new Error(`Unsupported class: ${className}`);
    error.statusCode = 404;
    throw error;
  }
}

function createClassHandler({ store }) {
  return async function classHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    try {
      const className = readClassName(req.query || {}, req.url);
      const objectId = readObjectId(req.query || {}, req.url);
      assertSupportedClass(className);

      if (req.method === 'GET') {
        const rows = await store.listObjects(className, parseOptions(req.query || {}));
        return sendJson(req, res, 200, { results: rows.map(rowToLeanCloudObject) });
      }

      if (req.method === 'POST') {
        const row = await store.createObject(className, normalizeBody(req.body));
        return sendJson(req, res, 201, rowToLeanCloudObject(row));
      }

      if (req.method === 'PUT') {
        const row = await store.updateObject(className, objectId, normalizeBody(req.body));
        return sendJson(req, res, 200, rowToLeanCloudObject(row));
      }

      if (req.method === 'DELETE') {
        await store.deleteObject(className, objectId);
        return sendJson(req, res, 200, {});
      }

      return sendJson(req, res, 405, { error: 'Method not allowed' });
    } catch (error) {
      return sendJson(req, res, error.statusCode || 500, { error: error.message });
    }
  };
}

function createLoginHandler({ store }) {
  return async function loginHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Method not allowed' });

    const body = normalizeBody(req.body);
    const username = body.username;
    const password = body.password;
    const user = await store.findUserByUsername(username);
    if (!user) return sendJson(req, res, 404, { error: 'Could not find user.' });

    const matches = await verifyPassword(password, user);
    if (!matches) return sendJson(req, res, 401, { error: 'The username and password mismatch.' });

    const sessionToken = createSessionToken();
    const updated = await store.updateUserSession(user.object_id, sessionToken);
    return sendJson(req, res, 200, publicUserFromRow(updated));
  };
}

function createMeHandler({ store }) {
  return async function meHandler(req, res) {
    const token = req.headers && (req.headers['x-lc-session'] || req.headers['X-LC-Session']);
    if (!token) return sendJson(req, res, 401, { error: 'Unauthorized' });
    const user = await store.findUserBySessionToken(token);
    if (!user) return sendJson(req, res, 401, { error: 'Unauthorized' });
    return sendJson(req, res, 200, publicUserFromRow(user));
  };
}

function createLogoutHandler() {
  return async function logoutHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    return sendJson(req, res, 200, {});
  };
}

function createSetupStatusHandler({ store }) {
  return async function setupStatusHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    if (req.method !== 'GET') return sendJson(req, res, 405, { error: 'Method not allowed' });
    try {
      return sendJson(req, res, 200, await store.setupStatus());
    } catch (error) {
      return sendJson(req, res, error.statusCode || 500, { error: error.message });
    }
  };
}

function createSetupInitHandler({ store }) {
  return async function setupInitHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Method not allowed' });
    try {
      await store.ensureSchema();
      return sendJson(req, res, 200, await store.setupStatus());
    } catch (error) {
      return sendJson(req, res, error.statusCode || 500, { error: error.message });
    }
  };
}

function createSetupMigrateHandler({ store }) {
  return async function setupMigrateHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Method not allowed' });
    try {
      const body = normalizeBody(req.body);
      const talks = parseLeanCloudJsonl(body.talks || '');
      const comments = parseLeanCloudJsonl(body.comments || '');

      await store.ensureSchema();
      for (const talk of talks) await store.createObject('shuoshuo', talk);
      for (const comment of comments) await store.createObject('atComment', comment);

      return sendJson(req, res, 200, {
        imported: {
          talks: talks.length,
          comments: comments.length
        }
      });
    } catch (error) {
      return sendJson(req, res, error.statusCode || 500, { error: error.message });
    }
  };
}

function createSetupRegisterAdminHandler({ store }) {
  return async function setupRegisterAdminHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Method not allowed' });
    try {
      const username = String(process.env.ADMIN_USERNAME || '').trim();
      const password = String(process.env.ADMIN_PASSWORD || '');
      if (!username || !password) {
        return sendJson(req, res, 400, { error: '请先设置 ADMIN_USERNAME 和 ADMIN_PASSWORD 环境变量。' });
      }

      // Only allow registering the first admin when user table is empty
      const status = await store.setupStatus();
      if (!status.initialized) {
        return sendJson(req, res, 400, { error: '请先初始化数据库。' });
      }
      if (status.counts.users > 0) {
        return sendJson(req, res, 400, { error: '管理员账户已存在。' });
      }

      const passwordRecord = await createPasswordHash(password);
      const img = process.env.ADMIN_IMG || null;
      const imgToken = process.env.ADMIN_IMG_Token || null;
      const user = await store.createUser({ username, img, imgToken, passwordRecord });
      const sessionToken = createSessionToken();
      const updated = await store.updateUserSession(user.object_id, sessionToken);
      return sendJson(req, res, 201, { status: 'success' });
    } catch (error) {
      return sendJson(req, res, error.statusCode || 500, { error: error.message });
    }
  };
}

module.exports = {
  createClassHandler,
  createLoginHandler,
  createLogoutHandler,
  createMeHandler,
  createSetupInitHandler,
  createSetupMigrateHandler,
  createSetupStatusHandler,
  createSetupRegisterAdminHandler
};
