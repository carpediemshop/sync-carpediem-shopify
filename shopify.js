import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";

/*
  CONFIG BASE SHOPIFY
*/

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

const SHOPIFY_CLIENT_ID = requiredEnv("SHOPIFY_CLIENT_ID");
const SHOPIFY_CLIENT_SECRET = requiredEnv("SHOPIFY_CLIENT_SECRET");
const SHOPIFY_SCOPES = requiredEnv("SHOPIFY_SCOPES");
const SHOPIFY_APP_URL = requiredEnv("SHOPIFY_APP_URL");

const hostName = SHOPIFY_APP_URL
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

/*
  ISTANZA API SHOPIFY
*/

const shopify = shopifyApi({
  apiKey: SHOPIFY_CLIENT_ID,
  apiSecretKey: SHOPIFY_CLIENT_SECRET,
  scopes: SHOPIFY_SCOPES.split(",").map(s => s.trim()).filter(Boolean),
  hostName,
  apiVersion: process.env.SHOPIFY_API_VERSION || LATEST_API_VERSION,
  isEmbeddedApp: false
});

/*
  EXPORT DEFAULT (FONDAMENTALE)
*/
export default shopify;

/*
  REST HELPER GENERICO
*/

export async function shopifyRest({
  shop,
  accessToken,
  method,
  path,
  body
}) {
  const url = `https://${shop}/admin/api/${shopify.config.apiVersion}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Shopify REST error ${res.status}: ${txt}`);
  }

  return res.json();
}

/*
  LIST PRODUCTS
*/

export async function listProducts(shop, accessToken, limit = 50) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/products.json?limit=${limit}`
  });

  return data.products || [];
}

/*
  GET PRODUCT
*/

export async function getProductById(shop, accessToken, productId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/products/${productId}.json`
  });

  return data.product;
}

/*
  GET VARIANT
*/

export async function getVariantById(shop, accessToken, variantId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/variants/${variantId}.json`
  });

  return data.variant;
}

/*
  GET MAIN LOCATION
*/

export async function getMainLocationId(shop, accessToken) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/locations.json`
  });

  if (!data.locations?.length) {
    throw new Error("No Shopify locations found");
  }

  return data.locations[0].id;
}

/*
  GET INVENTORY LEVEL
*/

export async function getInventoryLevel(shop, accessToken, inventoryItemId, locationId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${locationId}`
  });

  return data.inventory_levels?.[0]?.available ?? 0;
}
