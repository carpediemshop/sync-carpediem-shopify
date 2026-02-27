import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION, Session } from "@shopify/shopify-api";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required env var: ${name}`);
  return String(v).trim();
}

const SHOPIFY_CLIENT_ID = requiredEnv("SHOPIFY_CLIENT_ID");
const SHOPIFY_CLIENT_SECRET = requiredEnv("SHOPIFY_CLIENT_SECRET");
const SHOPIFY_SCOPES = requiredEnv("SHOPIFY_SCOPES");
const SHOPIFY_APP_URL = requiredEnv("SHOPIFY_APP_URL");

// Shopify API singleton
export const shopify = shopifyApi({
  apiKey: SHOPIFY_CLIENT_ID,
  apiSecretKey: SHOPIFY_CLIENT_SECRET,
  scopes: SHOPIFY_SCOPES.split(",").map(s => s.trim()).filter(Boolean),
  hostName: SHOPIFY_APP_URL.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION || LATEST_API_VERSION,
  isEmbeddedApp: false,
});

function makeOfflineSession(shop, accessToken) {
  // id può essere qualsiasi stringa stabile
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "na",
    isOnline: false,
    accessToken,
    scope: SHOPIFY_SCOPES,
  });
}

function normalizePath(path) {
  let p = String(path || "");
  p = p.replace(/^\/+/, "");     // via slash iniziale
  p = p.replace(/\.json$/i, ""); // via .json finale (tu passi /webhooks.json)
  return p;
}

/**
 * shopifyRest({ shop, accessToken, method, path, query, body })
 * -> esegue chiamate REST in stile "fetch"
 */
export async function shopifyRest({ shop, accessToken, method = "GET", path, query, body }) {
  const session = makeOfflineSession(shop, accessToken);
  const client = new shopify.clients.Rest({ session });

  const m = method.toUpperCase();
  const p = normalizePath(path);

  if (m === "GET")  return client.get({ path: p, query });
  if (m === "POST") return client.post({ path: p, query, data: body });
  if (m === "PUT")  return client.put({ path: p, query, data: body });
  if (m === "DELETE") return client.delete({ path: p, query });

  throw new Error(`Unsupported method: ${method}`);
}

/** listProducts(shop, accessToken, limit) */
export async function listProducts(shop, accessToken, limit = 50) {
  const res = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: "/products.json",
    query: { limit },
  });
  return res?.body?.products || [];
}

/** getProductById(shop, accessToken, productId) */
export async function getProductById(shop, accessToken, productId) {
  const res = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/products/${productId}.json`,
  });
  return res?.body?.product || null;
}

/** getVariantById(shop, accessToken, variantId) */
export async function getVariantById(shop, accessToken, variantId) {
  const res = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/variants/${variantId}.json`,
  });
  return res?.body?.variant || null;
}

/** getMainLocationId(shop, accessToken) */
export async function getMainLocationId(shop, accessToken) {
  const res = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: "/locations.json",
  });
  const locations = res?.body?.locations || [];
  return locations[0]?.id || null;
}

/**
 * getInventoryLevel(shop, accessToken, inventoryItemId, locationId)
 * (ordine uguale a come lo chiami nel tuo app.js)
 *
 * Ritorna un NUMERO quantity
 */
export async function getInventoryLevel(shop, accessToken, inventoryItemId, locationId) {
  if (!locationId) return 0;

  const res = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: "/inventory_levels.json",
    query: {
      location_ids: String(locationId),
      inventory_item_ids: String(inventoryItemId),
    },
  });

  const levels = res?.body?.inventory_levels || [];
  const available = levels[0]?.available;
  return Number.isFinite(available) ? available : 0;
}
