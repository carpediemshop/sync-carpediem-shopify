require("@shopify/shopify-api/adapters/node");
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cron = require("node-cron");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
const { initDb, upsertShopToken, getShopToken, markProcessed, isProcessed } = require("./db");

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));
app.use(bodyParser.json({ type: "application/json" }));

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_APP_URL,
  SHOPIFY_API_VERSION,
  SHOPIFY_WEBHOOK_SECRET
} = process.env;

if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_APP_URL) {
  console.warn("Missing env vars: SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET/SHOPIFY_APP_URL");
}

const apiVersion = SHOPIFY_API_VERSION || LATEST_API_VERSION;

const shopify = shopifyApi({
  apiKey: SHOPIFY_CLIENT_ID,
  apiSecretKey: SHOPIFY_CLIENT_SECRET,
  scopes: [
    "read_products",
    "read_inventory",
    "write_inventory",
    "read_orders"
  ],
  hostName: new URL(SHOPIFY_APP_URL).host,
  apiVersion
});

/** Utils **/
function verifyShopifyHmac(query) {
  const { hmac, ...map } = query;
  const message = Object.keys(map)
    .sort()
    .map((key) => `${key}=${Array.isArray(map[key]) ? map[key].join(",") : map[key]}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac || ""));
}

function verifyWebhook(rawBody, hmacHeader) {
  // Shopify sends base64 HMAC in X-Shopify-Hmac-Sha256
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET || SHOPIFY_CLIENT_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ""));
}

/** Health **/
app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * Install / OAuth start
 * Open: https://sync-carpediem.onrender.com/auth?shop=YOURSHOP.myshopify.com
 */
app.get("/auth", async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing ?shop=");

  // optional HMAC check if present
  if (req.query.hmac && !verifyShopifyHmac(req.query)) {
    return res.status(401).send("Invalid HMAC");
  }

  const redirectUrl = await shopify.auth.begin({
    shop,
    callbackPath: "/auth/callback",
    isOnline: false,
    rawRequest: req,
    rawResponse: res
  });

  return res.redirect(redirectUrl);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res
    });

    // Save token
    await upsertShopToken(session.shop, session.accessToken);

    // Register webhooks we need (orders + inventory)
    await registerWebhooks(session.shop);

    res.status(200).send(
      "✅ App autorizzata. Ora puoi chiudere questa pagina e aprire l’app da Shopify Admin."
    );
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth callback error: " + e.message);
  }
});

/** Shopify webhook endpoint **/
app.post("/webhooks/shopify", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const topic = req.get("X-Shopify-Topic");
  const shop = req.get("X-Shopify-Shop-Domain");
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const rawBody = req.body.toString("utf8");

  if (!verifyWebhook(rawBody, hmac)) {
    return res.status(401).send("Invalid webhook signature");
  }

  const payload = JSON.parse(rawBody);

  try {
    // For now we only log. In the next steps we will:
    // - On orders/create: compute per-SKU quantities and adjust inventory
    // - On inventory_levels/update: propagate to Amazon/eBay
    console.log("Webhook", { topic, shop });

    res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook error", e);
    res.status(500).send("error");
  }
});

/** Simple home **/
app.get("/", (req, res) => {
  res.status(200).send(
    "Sync CarpeDiem - server online. Usa /auth?shop=TUO-SHOP.myshopify.com per installare."
  );
});

/** Register required webhooks **/
async function registerWebhooks(shopDomain) {
  const token = await getShopToken(shopDomain);
  if (!token) throw new Error("Missing token for shop " + shopDomain);

  const client = new shopify.clients.Rest({ shop: shopDomain, accessToken: token });

  // topics we need
  const hooks = [
    { topic: "orders/create", address: `${SHOPIFY_APP_URL}/webhooks/shopify` },
    { topic: "orders/cancelled", address: `${SHOPIFY_APP_URL}/webhooks/shopify` },
    { topic: "inventory_levels/update", address: `${SHOPIFY_APP_URL}/webhooks/shopify` },
    { topic: "products/update", address: `${SHOPIFY_APP_URL}/webhooks/shopify` }
  ];

  for (const h of hooks) {
    try {
      await client.post({
        path: "webhooks",
        data: {
          webhook: {
            topic: h.topic,
            address: h.address,
            format: "json"
          }
        }
      });
      console.log("Webhook registered", h.topic);
    } catch (e) {
      console.log("Webhook register failed", h.topic, e?.response?.body || e.message);
    }
  }
}

/**
 * Polling skeleton (every 2 minutes)
 * NOTE: On Render Free this is NOT reliable because the service sleeps.
 * When we switch to paid instance, polling becomes reliable.
 */
cron.schedule("*/2 * * * *", async () => {
  try {
    // TODO: Amazon/eBay polling here
    // - fetch new orders
    // - if not processed -> decrement Shopify inventory by SKU
    // - mark processed
    // - update other channels with new qty
  } catch (e) {
    console.error("Cron error", e.message);
  }
});

initDb()
  .then(() => {
    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
