import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined
});

export async function upsertShopToken({ shop, accessToken, scope }) {
  await pool.query(
    `
    INSERT INTO shops(shop, access_token, scope)
    VALUES($1,$2,$3)
    ON CONFLICT (shop)
    DO UPDATE SET access_token=EXCLUDED.access_token, scope=EXCLUDED.scope, installed_at=now()
    `,
    [shop, accessToken, scope || null]
  );
}

export async function getShopToken(shop) {
  const r = await pool.query(`SELECT access_token FROM shops WHERE shop=$1`, [shop]);
  return r.rows[0]?.access_token || null;
}

export async function upsertEbayLink({
  shop,
  shopifyProductId,
  shopifyVariantId,
  sku,
  ebayOfferId,
  ebayListingId,
  status,
  lastError
}) {
  await pool.query(
    `
    INSERT INTO ebay_links(shop, shopify_product_id, shopify_variant_id, sku, ebay_offer_id, ebay_listing_id, status, last_error)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (shop, sku)
    DO UPDATE SET
      shopify_product_id=EXCLUDED.shopify_product_id,
      shopify_variant_id=EXCLUDED.shopify_variant_id,
      ebay_offer_id=COALESCE(EXCLUDED.ebay_offer_id, ebay_links.ebay_offer_id),
      ebay_listing_id=COALESCE(EXCLUDED.ebay_listing_id, ebay_links.ebay_listing_id),
      status=COALESCE(EXCLUDED.status, ebay_links.status),
      last_error=EXCLUDED.last_error
    `,
    [
      shop,
      shopifyProductId,
      shopifyVariantId,
      sku,
      ebayOfferId || null,
      ebayListingId || null,
      status || "linked",
      lastError || null
    ]
  );
}

export async function getEbayLinkBySku(shop, sku) {
  const r = await pool.query(
    `SELECT * FROM ebay_links WHERE shop=$1 AND sku=$2 LIMIT 1`,
    [shop, sku]
  );
  return r.rows[0] || null;
}

export async function listEbayLinks(shop, limit = 200) {
  const r = await pool.query(
    `
    SELECT sku, shopify_product_id, shopify_variant_id, status, ebay_offer_id, ebay_listing_id, last_error, updated_at
    FROM ebay_links
    WHERE shop=$1
    ORDER BY updated_at DESC
    LIMIT $2
    `,
    [shop, limit]
  );
  return r.rows;
}
