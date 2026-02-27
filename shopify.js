import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import fetch from "node-fetch";

export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_CLIENT_ID,
  apiSecretKey: process.env.SHOPIFY_CLIENT_SECRET,
  scopes: (process.env.SHOPIFY_SCOPES || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),
  hostName: new URL(process.env.SHOPIFY_APP_URL).host,
  apiVersion: process.env.SHOPIFY_API_VERSION || LATEST_API_VERSION,
  isEmbeddedApp: true
});

// REST helper semplice
export async function shopifyRest({ shop, accessToken, method, path, body }) {
  const url = `https://${shop}/admin/api/${shopify.config.apiVersion}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify REST ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function getMainLocationId(shop, accessToken) {
  const data = await shopifyRest({ shop, accessToken, method: "GET", path: "/locations.json" });
  return data?.locations?.[0]?.id || null;
}

export async function getInventoryLevel(shop, accessToken, inventoryItemId, locationId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${locationId}`
  });
  const lvl = data?.inventory_levels?.[0];
  return typeof lvl?.available === "number" ? lvl.available : 0;
}

export async function getProductById(shop, accessToken, productId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/products/${productId}.json`
  });
  return data?.product || null;
}

export async function getVariantById(shop, accessToken, variantId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/variants/${variantId}.json`
  });
  return data?.variant || null;
}

export async function listProducts(shop, accessToken, limit = 50) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/products.json?limit=${limit}`
  });
  return data?.products || [];
}
