require("dotenv").config();

let memory = {
  tokens: new Map(), // shopDomain -> accessToken
  processed: new Set() // id evento
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
    shopDomain
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

module.exports = {
  initDb,
  upsertShopToken,
  getShopToken,
  markProcessed,
  isProcessed
};
