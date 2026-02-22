require("@shopify/shopify-api/adapters/node");
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cron = require("node-cron");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
const { initDb, upsertShopToken, getShopToken } = require("./db");

const app = express();

// IMPORTANT: behind Render proxy
app.set("trust proxy", 1);

// --------------------
// 1) HEALTH (always)
// --------------------
app.get("/health", (req, res) => res.status(200).send("ok"));

// --------------------
// 2) WEBHOOK RAW BODY (must be BEFORE json middleware)
// --------------------
app.post(
  "/webhooks/shopify",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const topic = req.get("X-Shopify-Topic");
      const shop = req.get("X-Shopify-Shop-Domain");
      const hmac = req.get("X-Shopify-Hmac-Sha256");
      const rawBody = req.body.toString("utf8");

      if (!verifyWebhook(rawBody, hmac)) {
        return res.status(401).send("Invalid webhook signature");
      }

      // payload available if you need it:
      // const payload = JSON.parse(rawBody);

      console.log("✅ Webhook received", { topic, shop });

      return res.status(200).send("ok");
    } catch (e) {
      console.error("Webhook error:", e);
      if (!res.headersSent) return res.status(500).send("error");
    }
  }
);

// --------------------
// 3) JSON middleware for normal routes
// --------------------
app.use(bodyParser.json({ type: "application/json" }));

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_APP_URL,
  SHOPIFY_API_VERSION,
  SHOPIFY_WEBHOOK_SECRET,
} = process.env;

if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_APP_URL) {
  console.warn(
    "Missing env vars: SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_APP_URL"
  );
}

const apiVersion = SHOPIFY_API_VERSION || LATEST_API_VERSION;

const shopify = shopifyApi({
  apiKey: SHOPIFY_CLIENT_ID,
  apiSecretKey: SHOPIFY_CLIENT_SECRET,
  scopes: ["read_products", "read_inventory", "write_inventory", "read_orders"],
  hostName: new URL(SHOPIFY_APP_URL).host,
  apiVersion,
});

// --------------------
// HOME
// --------------------
app.get("/", (req, res) => {
  res
    .status(200)
    .send(
      "Sync CarpeDiem - server online. Usa /auth?shop=TUO-SHOP.myshopify.com per installare."
    );
});

// --------------------
// AUTH START
// Example: https://sync-carpediem.onrender.com/auth?shop=XXXX.myshopify.com
// --------------------
app.get("/auth", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();

    if (!shop) return res.status(400).send("Missing ?shop=");
    if (!shop.endsWith(".myshopify.com"))
      return res.status(400).send("Shop must end with .myshopify.com");

    // Optional HMAC check if present
    if (req.query.hmac && !verifyShopifyHmac(req.query)) {
      return res.status(401).send("Invalid HMAC");
    }

    const redirectUrl = await shopify.auth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });

    // IMPORTANT: ensure we send only once
    if (res.headersSent) return;
    return res.redirect(redirectUrl);
  } catch (e) {
    console.error("Auth begin error:", e);
    if (!res.headersSent) return res.status(500).send("Auth begin error: " + e.message);
  }
});

// --------------------
// AUTH CALLBACK
// --------------------
app.get("/auth/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    await upsertShopToken(session.shop, session.accessToken);

    // Register webhooks after install
    await registerWebhooks(session.shop);

    if (res.headersSent) return;
    return res
      .status(200)
      .send("✅ App autorizzata. Installazione completata.");
  } catch (e) {
    console.error("OAuth callback error:", e);
    if (!res.headersSent)
      return res.status(500).send("OAuth callback error: " + e.message);
  }
});

// --------------------
// REGISTER WEBHOOKS
// --------------------
async function registerWebhooks(shopDomain) {
  const token = await getShopToken(shopDomain);
  if (!token) throw new Error("Missing token for shop " + shopDomain);

  const client = new shopify.clients.Rest({ shop: shopDomain, accessToken: token });

  const hooks = [
    { topic: "orders/create", address: `${SHOPIFY_APP_URL}/webhooks/shopify` },
    { topic: "orders/cancelled", address: `${SHOPIFY_APP_URL}/webhooks/shopify` },
    { topic: "inventory_levels/update", address: `${SHOPIFY_APP_URL}/webhooks/shopify` },
    { topic: "products/update", address: `${SHOPIFY_APP_URL}/webhooks/shopify` },
  ];

  for (const h of hooks) {
    try {
      await client.post({
        path: "webhooks",
        data: { webhook: { topic: h.topic, address: h.address, format: "json" } },
      });
      console.log("✅ Webhook registered:", h.topic);
    } catch (e) {
      console.log("⚠️ Webhook register failed:", h.topic, e?.response?.body || e.message);
    }
  }
}

// --------------------
// HMAC utils
// --------------------
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

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac || ""));
  } catch {
    return false;
  }
}

function verifyWebhook(rawBody, hmacHeader) {
  const secret = SHOPIFY_WEBHOOK_SECRET || SHOPIFY_CLIENT_SECRET;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ""));
  } catch {
    return false;
  }
}

// --------------------
// CRON (placeholder)
// --------------------
cron.schedule("*/2 * * * *", async () => {
  try {
    // TODO later
  } catch (e) {
    console.error("Cron error:", e.message);
  }
});

// --------------------
// START
// --------------------
initDb()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
