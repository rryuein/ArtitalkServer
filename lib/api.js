const { createStore } = require('./store');
const { verifyPassword, createPasswordHash, createSessionToken } = require('./auth');
const { parseLeanCloudJsonl } = require('./import-jsonl');
const { rowToLeanCloudObject, publicUserFromRow } = require('./leancloud-shape');

const SUPPORTED_CLASSES = new Set(['shuoshuo', 'atComment']);

/* 鉴权
 *
 * 客户端（artitalk.js 的请求封装 n()）会在登录后自动带 X-LC-Session 头，
 * 这里用它换出用户；没登录 / token 无效一律 401。 */
function readSessionToken(req) {
  return (req.headers && (req.headers['x-lc-session'] || req.headers['X-LC-Session'])) || '';
}

async function requireAdmin(req, store) {
  const token = readSessionToken(req);
  if (!token) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  const user = await store.findUserBySessionToken(token);
  if (!user) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  return user;



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

const MAX_LIMIT = 200;   // 单次最多取 200 条，避免 ?limit=100000 把库一次拉空
  
function parseOptions(query) {
  let limit;
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_LIMIT) : undefined;
  }
  return {
    where: query.where ? JSON.parse(query.where) : {},
    order: query.order,
    limit:,
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
      /* 鉴权规则：
         · 修改 / 删除        → 必须登录
         · 发说说（shuoshuo） → 必须登录
         · 发评论（atComment）→ 允许匿名（访客留言） */
      if (req.method === 'PUT' || req.method === 'DELETE') {
        await requireAdmin(req, store);
      }
      if (req.method === 'POST' && className === 'shuoshuo') {
        await requireAdmin(req, store);
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
 // /api/login  —— 统一错误文案 + 简易限速
const loginAttempts = new Map();          // key: `${ip}|${username}` → { count, resetAt }
const LOGIN_WINDOW = 10 * 60 * 1000;      // 10 分钟
const LOGIN_MAX = 5;                      // 最多 5 次

function clientIp(req) {
  const forward = (req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'])) || '';
  return String(forward).split(',')[0].trim() || 'unknown';
}

function tooManyAttempts(key) {
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record || record.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW });
    return false;
  }
  record.count += 1;
  return record.count > LOGIN_MAX;
}
function createLoginHandler({ store }) {
  return async function loginHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Method not allowed' });

    const body = normalizeBody(req.body);
    const username = body.username;
    const password = body.password;
    const key = clientIp(req) + '|' + username;
    if (tooManyAttempts(key)) {
      return sendJson(req, res, 429, { error: '尝试次数过多，请稍后再试。' });
    }
    const user = await store.findUserByUsername(username);
    const matches = user ? await verifyPassword(password, user) : false;
    if (!user || !matches) {
      // 不再区分「用户不存在」和「密码错误」，避免用户名枚举
      return sendJson(req, res, 401, { error: '用户名或密码错误' });
    }
    
    loginAttempts.delete(key);
    
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

/* 登出：把数据库里的 session_token 清掉，旧 token 立即失效 */
function createLogoutHandler({ store }) {
  return async function logoutHandler(req, res) {
    if (req.method === 'OPTIONS') return sendJson(req, res, 204, {});
    try {
      const token = readSessionToken(req);
      if (token && store) {
        const user = await store.findUserBySessionToken(token);
        if (user) await store.updateUserSession(user.object_id, null);
      }
    } catch (error) {
      console.error('[logout]', error.message);
    }
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
