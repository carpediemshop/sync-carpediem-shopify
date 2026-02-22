require("dotenv").config();

let memory = {
  tokens: new Map(), // shopDomain -> accessToken
  processed: new Set(), // id evento
  runs: [], // fallback
  runLogs: new Map(), // runId -> logs[]
};

let pg = null;
let pool = null;

function hasDb() {
  return !!pool;
}

async function initDb() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.log(
      "DATABASE_URL not set. Using in-memory fallback (NON consigliato in produzione)."
    );
    return;
  }

  pg = require("pg");
  pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  // Token shop
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_tokens (
      shop_domain TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Dedup eventi webhook (opzionale)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_events (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Runs (UUID TEXT) + Logs (run_id TEXT)  ✅ evita mismatch bigint/text
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',  -- running|success|error
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_logs (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      level TEXT NOT NULL DEFAULT 'info',      -- info|warn|error
      message TEXT NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_runs_shop_started ON runs(shop_domain, started_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_logs_run_created ON run_logs(run_id, created_at ASC);`);

  console.log("DB ready (Postgres).");
}

// ---------------- TOKENS ----------------

async function upsertShopToken(shopDomain, accessToken) {
  if (!hasDb()) {
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
  if (!hasDb()) return memory.tokens.get(shopDomain) || null;

  const r = await pool.query(
    `SELECT access_token FROM shop_tokens WHERE shop_domain = $1`,
    [shopDomain]
  );
  return r.rows[0]?.access_token || null;
}

// ---------------- PROCESSED EVENTS ----------------

async function markProcessed(id) {
  if (!hasDb()) {
    memory.processed.add(id);
    return;
  }
  await pool.query(
    `INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [id]
  );
}

async function isProcessed(id) {
  if (!hasDb()) return memory.processed.has(id);

  const r = await pool.query(`SELECT 1 FROM processed_events WHERE id = $1`, [id]);
  return r.rowCount > 0;
}

// ---------------- RUNS + LOGS ----------------

function uuid() {
  const crypto = require("crypto");
  return crypto.randomUUID();
}

async function createRun({ shopDomain, trigger = "manual", summary = {} }) {
  const runId = uuid();

  if (!hasDb()) {
    const run = {
      id: runId,
      shop_domain: shopDomain,
      trigger,
      status: "running",
      summary,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    memory.runs.unshift(run);
    memory.runLogs.set(runId, []);
    return runId;
  }

  await pool.query(
    `
    INSERT INTO runs (id, shop_domain, trigger, status, summary)
    VALUES ($1, $2, $3, 'running', $4::jsonb)
  `,
    [runId, shopDomain, trigger, JSON.stringify(summary || {})]
  );

  return runId;
}

async function addRunLog(runId, { level = "info", message, meta = {} }) {
  if (!message) return;

  if (!hasDb()) {
    const arr = memory.runLogs.get(runId) || [];
    arr.push({
      level,
      message,
      meta,
      created_at: new Date().toISOString(),
    });
    memory.runLogs.set(runId, arr);
    return;
  }

  await pool.query(
    `
    INSERT INTO run_logs (run_id, level, message, meta)
    VALUES ($1, $2, $3, $4::jsonb)
  `,
    [runId, level, message, JSON.stringify(meta || {})]
  );
}

async function finishRun(runId, { status = "success", summary = {} }) {
  if (!hasDb()) {
    const run = memory.runs.find((r) => r.id === runId);
    if (run) {
      run.status = status;
      run.summary = summary || {};
      run.finished_at = new Date().toISOString();
    }
    return;
  }

  await pool.query(
    `
    UPDATE runs
    SET status = $2,
        summary = $3::jsonb,
        finished_at = NOW()
    WHERE id = $1
  `,
    [runId, status, JSON.stringify(summary || {})]
  );
}

async function listRuns(shopDomain, limit = 30) {
  if (!hasDb()) {
    return (memory.runs || [])
      .filter((r) => r.shop_domain === shopDomain)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        shop_domain: r.shop_domain,
        trigger: r.trigger,
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        summary: r.summary,
      }));
  }

  const r = await pool.query(
    `
    SELECT id, shop_domain, trigger, status, summary, started_at, finished_at
    FROM runs
    WHERE shop_domain = $1
    ORDER BY started_at DESC
    LIMIT $2
  `,
    [shopDomain, limit]
  );
  return r.rows;
}

async function getRunWithLogs(runId, logLimit = 400) {
  if (!hasDb()) {
    const run = (memory.runs || []).find((x) => x.id === runId) || null;
    const logs = (memory.runLogs.get(runId) || []).slice(-logLimit);
    return { run, logs };
  }

  const runRes = await pool.query(
    `SELECT id, shop_domain, trigger, status, summary, started_at, finished_at FROM runs WHERE id = $1`,
    [runId]
  );
  const run = runRes.rows[0] || null;

  const logsRes = await pool.query(
    `
    SELECT level, message, meta, created_at
    FROM run_logs
    WHERE run_id = $1
    ORDER BY created_at ASC
    LIMIT $2
  `,
    [runId, logLimit]
  );

  return { run, logs: logsRes.rows };
}

module.exports = {
  initDb,
  upsertShopToken,
  getShopToken,
  markProcessed,
  isProcessed,
  createRun,
  addRunLog,
  finishRun,
  listRuns,
  getRunWithLogs,
};
