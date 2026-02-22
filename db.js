require("dotenv").config();

let memory = {
  tokens: new Map(), // shopDomain -> accessToken
  processed: new Set(), // id evento
  runs: [],
  logs: []
};

let pg = null;
let pool = null;

async function initDb() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.log("DATABASE_URL not set. Using in-memory fallback (NON consigliato in produzione).");
    return;
  }

  pg = require("pg");
  pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  // =============================
  // TABELLE BASE
  // =============================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_tokens (
      shop_domain TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_events (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // =============================
  // NUOVE TABELLE DASHBOARD
  // =============================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id BIGSERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      summary JSONB,
      error TEXT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_runs_shop_time
    ON sync_runs (shop_domain, started_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_logs (
      id BIGSERIAL PRIMARY KEY,
      shop_domain TEXT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_logs_time
    ON app_logs (created_at DESC);
  `);

  console.log("DB ready (Postgres).");
}

// =============================
// TOKEN SHOP
// =============================

async function upsertShopToken(shopDomain, accessToken) {
  if (!pool) {
    memory.tokens.set(shopDomain, accessToken);
    return;
  }

  await pool.query(
    `
    INSERT INTO shop_tokens (shop_domain, access_token, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (shop_domain)
    DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = NOW();
  `,
    [shopDomain, accessToken]
  );
}

async function getShopToken(shopDomain) {
  if (!pool) return memory.tokens.get(shopDomain) || null;

  const r = await pool.query(
    `SELECT access_token FROM shop_tokens WHERE shop_domain = $1`,
    [shopDomain]
  );

  return r.rows[0]?.access_token || null;
}

// =============================
// EVENTI PROCESSATI
// =============================

async function markProcessed(id) {
  if (!pool) {
    memory.processed.add(id);
    return;
  }

  await pool.query(
    `INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [id]
  );
}

async function isProcessed(id) {
  if (!pool) return memory.processed.has(id);

  const r = await pool.query(
    `SELECT 1 FROM processed_events WHERE id = $1`,
    [id]
  );

  return r.rowCount > 0;
}

// =============================
// SYNC RUNS (DASHBOARD)
// =============================

async function createRun(shopDomain, jobType) {
  if (!pool) {
    const run = {
      id: Date.now(),
      shop_domain: shopDomain,
      job_type: jobType,
      status: "running",
      started_at: new Date().toISOString()
    };
    memory.runs.unshift(run);
    return run.id;
  }

  const r = await pool.query(
    `
    INSERT INTO sync_runs (shop_domain, job_type, status)
    VALUES ($1, $2, 'running')
    RETURNING id;
  `,
    [shopDomain, jobType]
  );

  return r.rows[0].id;
}

async function finishRun(id, status, durationMs, summary, error) {
  if (!pool) {
    const run = memory.runs.find(r => r.id === id);
    if (run) {
      run.status = status;
      run.finished_at = new Date().toISOString();
      run.duration_ms = durationMs;
      run.summary = summary;
      run.error = error;
    }
    return;
  }

  await pool.query(
    `
    UPDATE sync_runs
    SET status = $1,
        finished_at = NOW(),
        duration_ms = $2,
        summary = $3,
        error = $4
    WHERE id = $5;
  `,
    [status, durationMs, summary ? JSON.stringify(summary) : null, error, id]
  );
}

async function listRuns(shopDomain, limit = 50) {
  if (!pool) return memory.runs.slice(0, limit);

  const r = await pool.query(
    `
    SELECT * FROM sync_runs
    WHERE shop_domain = $1
    ORDER BY started_at DESC
    LIMIT $2;
  `,
    [shopDomain, limit]
  );

  return r.rows;
}

async function getLastRun(shopDomain) {
  if (!pool) return memory.runs[0] || null;

  const r = await pool.query(
    `
    SELECT * FROM sync_runs
    WHERE shop_domain = $1
    ORDER BY started_at DESC
    LIMIT 1;
  `,
    [shopDomain]
  );

  return r.rows[0] || null;
}

// =============================
// LOG SISTEMA
// =============================

async function logEvent(shopDomain, level, message, meta = null) {
  if (!pool) {
    memory.logs.unshift({
      shop_domain: shopDomain,
      level,
      message,
      meta,
      created_at: new Date().toISOString()
    });
    return;
  }

  await pool.query(
    `
    INSERT INTO app_logs (shop_domain, level, message, meta)
    VALUES ($1, $2, $3, $4);
  `,
    [shopDomain, level, message, meta ? JSON.stringify(meta) : null]
  );
}

async function listLogs(shopDomain, limit = 30) {
  if (!pool) return memory.logs.slice(0, limit);

  const r = await pool.query(
    `
    SELECT * FROM app_logs
    WHERE shop_domain = $1
    ORDER BY created_at DESC
    LIMIT $2;
  `,
    [shopDomain, limit]
  );

  return r.rows;
}

async function countErrors24h(shopDomain) {
  if (!pool) {
    return memory.logs.filter(
      l => l.shop_domain === shopDomain && l.level === "error"
    ).length;
  }

  const r = await pool.query(
    `
    SELECT COUNT(*) FROM app_logs
    WHERE shop_domain = $1
      AND level = 'error'
      AND created_at > NOW() - INTERVAL '24 hours';
  `,
    [shopDomain]
  );

  return parseInt(r.rows[0].count, 10);
}

// =============================

module.exports = {
  initDb,
  upsertShopToken,
  getShopToken,
  markProcessed,
  isProcessed,
  createRun,
  finishRun,
  listRuns,
  getLastRun,
  logEvent,
  listLogs,
  countErrors24h
};
