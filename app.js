require("@shopify/shopify-api/adapters/node");
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cron = require("node-cron");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");

const {
  initDb,
  upsertShopToken,
  getShopToken,
  markProcessed,
  isProcessed
} = require("./db");

const app = express();

// JSON per le normali route
app.use(bodyParser.json({ type: "application/json" }));

/** ENV **/
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

// Shopify SDK
const shopify = shopifyApi({
  apiKey: SHOPIFY_CLIENT_ID,
  apiSecretKey: SHOPIFY_CLIENT_SECRET,
  scopes: ["read_products", "read_inventory", "write_inventory", "read_orders"],
  hostName: new URL(SHOPIFY_APP_URL).host,
  apiVersion
});

/** Utils **/
function verifyShopifyHmac(query) {
  // Verifica HMAC per /auth e callback (querystring)
  const { hmac, signature, ...map } = query; // signature a volte presente
  const message = Object.keys(map)
    .sort()
    .map((key) => `${key}=${Array.isArray(map[key]) ? map[key].join(",") : map[key]}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest("hex");

  // timingSafeEqual vuole buffer della stessa lunghezza
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmac || "", "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyWebhook(rawBody, hmacHeader) {
  // Shopify manda base64 in X-Shopify-Hmac-Sha256
  const secret = SHOPIFY_WEBHOOK_SECRET || SHOPIFY_CLIENT_SECRET;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmacHeader || "", "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Health **/
app.get("/health", (req, res) => res.status(200).send("ok"));

/** Home **/
app.get("/", (req, res) => {
  res
    .status(200)
    .send("Sync CarpeDiem - server online. Usa /auth?shop=TUO-SHOP.myshopify.com per installare.");
});

/**
 * OAuth start
 * Apri:
 * https://sync-carpediem.onrender.com/auth?shop=carpediemstore.it  (NO)
 * Deve essere dominio Shopify:
 * https://sync-carpediem.onrender.com/auth?shop=TUOSHOP.myshopify.com
 */
app.get("/auth", async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing ?shop=");

  // opzionale: se Shopify manda hmac, verifichiamo
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
    // se vuoi essere super-stricto, puoi anche verificare req.query.hmac qui
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res
    });

    await upsertShopToken(session.shop, session.accessToken);

    await registerWebhooks(session.shop);

    return res
      .status(200)
      .send("✅ App autorizzata. Ora puoi chiudere questa pagina e aprire l’app da Shopify Admin.");
  } catch (e) {
    console.error("OAuth callback error:", e);
    return res.status(500).send("OAuth callback error: " + e.message);
  }
});

/** Webhook endpoint (RAW BODY!) **/
app.post("/webhooks/shopify", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const topic = req.get("X-Shopify-Topic");
  const shop = req.get("X-Shopify-Shop-Domain");
  const hmac = req.get("X-Shopify-Hmac-Sha256");

  const rawBody = req.body.toString("utf8");

  if (!verifyWebhook(rawBody, hmac)) {
    return res.status(401).send("Invalid webhook signature");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).send("Invalid JSON");
  }

  try {
    // TODO: qui poi mettiamo la logica vera (ordini -> inventory)
    console.log("Webhook received:", { topic, shop });

    // esempio anti-duplicati (se vuoi usarlo più avanti):
    // const eventId = req.get("X-Shopify-Webhook-Id") || `${shop}:${topic}:${payload?.id || ""}`;
    // if (await isProcessed(eventId)) return res.status(200).send("dup");
    // await markProcessed(eventId);

    return res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook handler error:", e);
    return res.status(500).send("error");
  }
});

/** Register webhooks **/
async function registerWebhooks(shopDomain) {
  const token = await getShopToken(shopDomain);
  if (!token) throw new Error("Missing token for shop " + shopDomain);

  // ✅ modo compatibile con @shopify/shopify-api recente: client con session
  const session = shopify.session.customAppSession(shopDomain);
  session.accessToken = token;

  const client = new shopify.clients.Rest({ session });

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
      console.log("Webhook registered:", h.topic);
    } catch (e) {
      console.log("Webhook register failed:", h.topic, e?.response?.body || e.message);
    }
  }
}

/**
 * Polling skeleton (ogni 2 minuti)
 * Render Free “dorme” → non affidabile.
 */
cron.schedule("*/2 * * * *", async () => {
  try {
    // TODO: qui in futuro Amazon/eBay polling
  } catch (e) {
    console.error("Cron error:", e.message);
  }
});

/** START **/
initDb()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
