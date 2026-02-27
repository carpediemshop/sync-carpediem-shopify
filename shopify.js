import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";

/**
 * Shopify API singleton
 */
export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_CLIENT_ID,
  apiSecretKey: process.env.SHOPIFY_CLIENT_SECRET,
  scopes: (process.env.SHOPIFY_SCOPES || "").split(",").map(s => s.trim()).filter(Boolean),
  hostName: (process.env.SHOPIFY_APP_URL || "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
  apiVersion: process.env.SHOPIFY_API_VERSION || LATEST_API_VERSION,
  isEmbeddedApp: false,
});

/**
 * Helper: Rest client
 */
export function shopifyRest(session) {
  return new shopify.clients.Rest({ session });
}

/**
 * Lista prodotti (REST)
 */
export async function listProducts(session, limit = 50) {
  const client = shopifyRest(session);
  const res = await client.get({
    path: "products",
    query: { limit },
  });
  return res.body?.products || [];
}

/**
 * Location principale (serve per inventory_levels)
 */
export async function getMainLocationId(session) {
  const client = shopifyRest(session);
  const res = await client.get({ path: "locations" });
  const locations = res.body?.locations || [];
  return locations[0]?.id || null;
}

/**
 * Inventory level per inventory_item_id + location_id
 */
export async function getInventoryLevel(session, locationId, inventoryItemId) {
  const client = shopifyRest(session);
  const res = await client.get({
    path: "inventory_levels",
    query: {
      location_ids: String(locationId),
      inventory_item_ids: String(inventoryItemId),
    },
  });
  const levels = res.body?.inventory_levels || [];
  return levels[0] || null;
}

/**
 * Product by ID
 */
export async function getProductById(session, productId) {
  const client = shopifyRest(session);
  const res = await client.get({ path: `products/${productId}` });
  return res.body?.product || null;
}

/**
 * Variant by ID
 */
export async function getVariantById(session, variantId) {
  const client = shopifyRest(session);
  const res = await client.get({ path: `variants/${variantId}` });
  return res.body?.variant || null;
}
