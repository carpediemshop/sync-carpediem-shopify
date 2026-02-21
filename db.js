const { Pool } = require("pg");

let pool;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL not set. Using in-memory fallback (NON consigliato in produzione).");
    // in-memory fallback
    global.__TOKENS__ = global.__TOKENS__ || new Map();
    global.__PROCESSED__ = global.__PROCESSED__ || new Set();
    return;
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_tokens (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_orders (
      platform TEXT NOT NULL,
      order_id TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (platform, order_id)
    );
  `);
}

async function upsertShopToken(shop, accessToken) {
  if (!pool) {
    global.__TOKENS__.set(shop, accessToken);
    return;
  }
  await pool.query(
    `INSERT INTO shop_tokens(shop, access_token) VALUES ($1,$2)
     ON CONFLICT (shop) DO UPDATE SET access_token=$2, updated_at=NOW()`,
    [shop, accessToken]
  );
}

async function getShopToken(shop) {
  if (!pool) return global.__TOKENS__.get(shop);
  const r = await pool.query(`SELECT access_token FROM shop_tokens WHERE shop=$1`, [shop]);
  return r.rows[0]?.access_token || null;
}

async function markProcessed(platform, orderId) {
  if (!pool) {
    global.__PROCESSED__.add(`${platform}:${orderId}`);
    return;
  }
  await pool.query(
    `INSERT INTO processed_orders(platform, order_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [platform, orderId]
  );
}

async function isProcessed(platform, orderId) {
  if (!pool) return global.__PROCESSED__.has(`${platform}:${orderId}`);
  const r = await pool.query(
    `SELECT 1 FROM processed_orders WHERE platform=$1 AND order_id=$2`,
    [platform, orderId]
  );
  return r.rowCount > 0;
}

module.exports = {
  initDb,
  upsertShopToken,
  getShopToken,
  markProcessed,
  isProcessed
};
