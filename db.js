require("dotenv").config();
const crypto = require("crypto");

let memory = {
  tokens: new Map(),      // shopDomain -> accessToken
  processed: new Set(),   // id evento
  runs: [],               // fallback demo
  runLogs: new Map(),     // runId -> logs[]
};

let pg = null;
let pool = null;

function newRunId() {
  // Node 18+ ha crypto.randomUUID()
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

async function initDb() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.log("DATABASE_URL not set. Using in-memory fallback (NON consigliato in produzione).");
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

  // Dedup eventi webhook
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_events (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Runs (ID TEXT così non avrai più mismatch)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',
      summary JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_logs (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Indici utili
  await pool.query(`CREATE INDEX IF NOT EXISTS runs_shop_started_idx ON runs (shop_domain, started_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS run_logs_run_created_idx ON run_logs (run_id, created_at ASC);`);

  console.log("DB ready (Postgres).");
}

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

  const r = await pool.query(`SELECT access_token FROM shop_tokens WHERE shop_domain = $1`, [
    shopDomain,
  ]);
  return r.rows[0]?.access_token || null;
}

async function markProcessed(id) {
  if (!pool) {
    memory.processed.add(id);
    return;
  }
  await pool.query(`INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
}

async function isProcessed(id) {
  if (!pool) return memory.processed.has(id);

  const r = await pool.query(`SELECT 1 FROM processed_events WHERE id = $1`, [id]);
  return r.rowCount > 0;
}

// ---------- RUNS ----------
async function createRun({ shopDomain, trigger = "manual", summary = null }) {
  const runId = newRunId();

  if (!pool) {
    memory.runs.unshift({
      id: runId,
      shop_domain: shopDomain,
      trigger,
      status: "running",
      summary,
      started_at: new Date().toISOString(),
      finished_at: null,
    });
    memory.runLogs.set(runId, []);
    return runId;
  }

  await pool.query(
    `
    INSERT INTO runs (id, shop_domain, trigger, status, summary)
    VALUES ($1, $2, $3, 'running', $4)
  `,
    [runId, shopDomain, trigger, summary]
  );

  return runId;
}

async function addRunLog(runId, { level = "info", message }) {
  if (!message) return;

  if (!pool) {
    const arr = memory.runLogs.get(runId) || [];
    arr.push({ level, message, created_at: new Date().toISOString() });
    memory.runLogs.set(runId, arr);
    return;
  }

  await pool.query(
    `
    INSERT INTO run_logs (run_id, level, message)
    VALUES ($1, $2, $3)
  `,
    [runId, level, message]
  );
}

async function finishRun(runId, { status = "success", summary = null } = {}) {
  if (!pool) {
    const run = memory.runs.find((r) => r.id === runId);
    if (run) {
      run.status = status;
      run.summary = summary;
      run.finished_at = new Date().toISOString();
    }
    return;
  }

  await pool.query(
    `
    UPDATE runs
    SET status = $2,
        summary = COALESCE($3, summary),
        finished_at = NOW()
    WHERE id = $1
  `,
    [runId, status, summary]
  );
}

async function listRuns(shopDomain, limit = 30) {
  if (!pool) {
    return memory.runs.filter((r) => r.shop_domain === shopDomain).slice(0, limit);
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

async function getRunWithLogs(runId, limitLogs = 400) {
  if (!pool) {
    const run = memory.runs.find((r) => r.id === runId) || null;
    const logs = (memory.runLogs.get(runId) || []).slice(-limitLogs);
    return { run, logs };
  }

  const runRes = await pool.query(
    `
    SELECT id, shop_domain, trigger, status, summary, started_at, finished_at
    FROM runs
    WHERE id = $1
  `,
    [runId]
  );

  const logsRes = await pool.query(
    `
    SELECT id, run_id, level, message, created_at
    FROM run_logs
    WHERE run_id = $1
    ORDER BY created_at ASC
    LIMIT $2
  `,
    [runId, limitLogs]
  );

  return { run: runRes.rows[0] || null, logs: logsRes.rows };
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
