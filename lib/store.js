const { neon } = require('@neondatabase/serverless');

function objectId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function tableForClass(className) {
  if (className === 'shuoshuo') return 'artitalk_talks';
  if (className === 'atComment') return 'artitalk_comments';
  throw new Error(`Unsupported class: ${className}`);
}

function mapOrder(order) {
  if (!order) return 'created_at DESC';
  return order.split(',').map((item) => {
    const direction = item.startsWith('-') ? 'DESC' : 'ASC';
    const field = item.replace(/^-/, '');
    if (field === 'createdAt') return `created_at ${direction}`;
    if (field === 'updatedAt') return `updated_at ${direction}`;
    if (field === 'isPinned') return `(data->>'isPinned' = 'true') ${direction}`;
    throw new Error(`Unsupported order field: ${field}`);
  }).join(', ');
}

function attrExpression(key) {
  if (key === 'objectId') return 'object_id';
  if (key === 'createdAt') return 'created_at';
  if (key === 'updatedAt') return 'updated_at';
  return `data->>'${key.replace(/'/g, "''")}'`;
}

function createStore(databaseUrl = process.env.ARTITALK_DATABASE_URL) {
  if (!databaseUrl) throw new Error('ARTITALK_DATABASE_URL is required');
  const sql = neon(databaseUrl);

  async function ensureSchema() {
    await sql`
      CREATE TABLE IF NOT EXISTS artitalk_users (
        object_id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        img TEXT,
        img_token TEXT,
        password_hash TEXT,
        password_salt TEXT,
        password_algorithm TEXT,
        password_iterations INTEGER,
        session_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        source_data JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS artitalk_talks (
        object_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS artitalk_comments (
        object_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
  }

  async function setupStatus() {
    const tableRows = await sql.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name IN ('artitalk_users', 'artitalk_talks', 'artitalk_comments')`
    );
    const initialized = tableRows.length === 3;
    if (!initialized) {
      return { initialized: false, empty: true, counts: { users: 0, talks: 0, comments: 0 } };
    }
    const userRows = await sql.query('SELECT count(*)::int AS count FROM artitalk_users');
    const talkRows = await sql.query('SELECT count(*)::int AS count FROM artitalk_talks');
    const commentRows = await sql.query('SELECT count(*)::int AS count FROM artitalk_comments');
    const counts = {
      users: userRows[0].count,
      talks: talkRows[0].count,
      comments: commentRows[0].count
    };
    return {
      initialized,
      empty: counts.users === 0 && counts.talks === 0 && counts.comments === 0,
      counts
    };
  }

  async function listObjects(className, options = {}) {
    const table = tableForClass(className);
    const where = options.where || {};
    const clauses = [];
    const values = [];
    for (const [key, value] of Object.entries(where)) {
      clauses.push(`${attrExpression(key)} = $${values.length + 1}`);
      values.push(String(value));
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderSql = `ORDER BY ${mapOrder(options.order)}`;
    const limit = Number.isFinite(options.limit) ? options.limit : 100;
    const skip = Number.isFinite(options.skip) ? options.skip : 0;
    return sql.query(
      `SELECT object_id, data, created_at, updated_at FROM ${table} ${whereSql} ${orderSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, skip]
    );
  }

  /* 写入：objectId 一律由服务端生成，绝不接受客户端传入。
     原来 `data.objectId || objectId()` + ON CONFLICT DO UPDATE 的组合，
     意味着带一个已知 objectId 的 POST 就能原地覆盖任意说说/评论。 */
  async function createObject(className, data) {
    return insertObject(className, objectId(), data);
  }

  /* 只给数据迁移用：保留 LeanCloud 原来的 objectId（调用方必须先鉴权） */
  async function createObjectWithId(className, data) {
    const id = data.objectId || data.id || objectId();
    return insertObject(className, id, data);
  }

  async function insertObject(className, id, data) {
    const table = tableForClass(className);
    const createdAt = data.createdAt || new Date().toISOString();
    const updatedAt = data.updatedAt || createdAt;
    const cleanData = { ...data };
    delete cleanData.objectId;
    delete cleanData.createdAt;
    delete cleanData.updatedAt;
    const rows = await sql.query(
      `INSERT INTO ${table} (object_id, data, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (object_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
       RETURNING object_id, data, created_at, updated_at`,
      [id, JSON.stringify(cleanData), createdAt, updatedAt]
    );
    return rows[0];
  }

  async function updateObject(className, id, data) {
    const table = tableForClass(className);
    const rows = await sql.query(
      `UPDATE ${table} SET data = data || $2::jsonb, updated_at = now() WHERE object_id = $1 RETURNING object_id, data, created_at, updated_at`,
      [id, JSON.stringify(data)]
    );
    if (!rows[0]) throw new Error('Object not found');
    return rows[0];
  }

  async function deleteObject(className, id) {
    const table = tableForClass(className);
    await sql.query(`DELETE FROM ${table} WHERE object_id = $1`, [id]);
  }

  async function countUsers() {
    const rows = await sql.query('SELECT count(*)::int AS count FROM artitalk_users');
    return rows[0].count;
  }

  async function createUser({ username, img, imgToken, passwordRecord }) {
    const id = objectId();
    const now = new Date().toISOString();
    const rows = await sql.query(
      `INSERT INTO artitalk_users (object_id, username, img, img_token, password_hash, password_salt, password_algorithm, password_iterations, created_at, updated_at, source_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [id, username, img || null, imgToken || null, passwordRecord.password_hash, passwordRecord.password_salt, passwordRecord.password_algorithm, passwordRecord.password_iterations, now, now, JSON.stringify({})]
    );
    return rows[0];
  }

  async function findUserByUsername(username) {
    const rows = await sql.query('SELECT * FROM artitalk_users WHERE username = $1', [username]);
    return rows[0];
  }

  async function findUserBySessionToken(sessionToken) {
    const rows = await sql.query('SELECT * FROM artitalk_users WHERE session_token = $1', [sessionToken]);
    return rows[0];
  }

  async function updateUserSession(id, sessionToken) {
    const rows = await sql.query('UPDATE artitalk_users SET session_token = $2, updated_at = now() WHERE object_id = $1 RETURNING *', [id, sessionToken]);
    return rows[0];
  }

  return {
    ensureSchema,
    setupStatus,
    listObjects,
    createObject,
    createObjectWithId,
    updateObject,
    deleteObject,
    findUserByUsername,
    findUserBySessionToken,
    updateUserSession,
    createUser
  };
}

module.exports = {
  createStore,
  mapOrder
};
