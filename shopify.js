import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    // Non fare crash “misterioso”: errore chiarissimo nei log
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

const SHOPIFY_CLIENT_ID = requiredEnv("SHOPIFY_CLIENT_ID");
const SHOPIFY_CLIENT_SECRET = requiredEnv("SHOPIFY_CLIENT_SECRET");
const SHOPIFY_SCOPES = requiredEnv("SHOPIFY_SCOPES");
const SHOPIFY_APP_URL = requiredEnv("SHOPIFY_APP_URL");

const hostName = SHOPIFY_APP_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");

const shopify = shopifyApi({
  apiKey: SHOPIFY_CLIENT_ID,
  apiSecretKey: SHOPIFY_CLIENT_SECRET,
  scopes: SHOPIFY_SCOPES.split(",").map(s => s.trim()).filter(Boolean),
  hostName,
  apiVersion: process.env.SHOPIFY_API_VERSION || LATEST_API_VERSION,
  isEmbeddedApp: false,
});

export default shopify;
