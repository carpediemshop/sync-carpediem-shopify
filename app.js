require("@shopify/shopify-api/adapters/node");
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const { initDb, upsertShopToken } = require("./db");

const app = express();
app.set("trust proxy", 1);

// ---------- ENV ----------
const {
  SHOPIFY_APP_URL,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_WEBHOOK_SECRET,
} = process.env;

if (!SHOPIFY_APP_URL || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error("Missing env. Required: SHOPIFY_APP_URL, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET");
}

// Scopes: tienili coerenti con ciò che vuoi fare
const SCOPES = [
  "read_products",
  "write_inventory",
  "read_orders",
].join(",");

// ---------- helpers ----------
function isValidShop(shop) {
  return typeof shop === "string" && /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop);
}

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Shopify OAuth HMAC verification (querystring)
function verifyOAuthHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(",") : rest[key]}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return timingSafeEqual(digest, hmac);
}

function randomState() {
  return crypto.randomBytes(16).toString("hex");
}

// Memoria per state OAuth (ok per ora; in produzione meglio DB/Redis)
const oauthStates = new Map(); // state -> { shop, host, createdAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function putState(state, payload) {
  oauthStates.set(state, { ...payload, createdAt: Date.now() });
}
function getState(state) {
  const v = oauthStates.get(state);
  if (!v) return null;
  if (Date.now() - v.createdAt > STATE_TTL_MS) {
    oauthStates.delete(state);
    return null;
  }
  return v;
}
function delState(state) {
  oauthStates.delete(state);
}

// ---------- 1) HEALTH ----------
app.get("/health", (req, res) => res.status(200).send("ok"));

// ---------- 2) WEBHOOK endpoint (opzionale) ----------
app.post(
  "/webhooks/shopify",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    try {
      if (!SHOPIFY_WEBHOOK_SECRET) {
        // Se non usi webhooks adesso, rispondi 200 e basta
        return res.status(200).send("ok");
      }

      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const body = req.body; // Buffer
      const digest = crypto
        .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
        .update(body)
        .digest("base64");

      if (!hmacHeader || !timingSafeEqual(digest, hmacHeader)) {
        return res.status(401).send("invalid webhook hmac");
      }

      // Qui puoi gestire i topic se vuoi
      // const topic = req.get("X-Shopify-Topic");
      return res.status(200).send("ok");
    } catch (e) {
      console.error("Webhook error:", e);
      return res.status(500).send("error");
    }
  }
);

// ---------- 3) OAUTH START ----------
app.get("/auth", (req, res) => {
  try {
    const shop = req.query.shop;
    const host = req.query.host; // a volte Shopify lo passa (embedded)
    if (!isValidShop(shop)) {
      return res.status(400).send("Invalid or missing shop parameter");
    }

    const state = randomState();
    putState(state, { shop, host: host || "" });

    const redirectUri = `${SHOPIFY_APP_URL}/auth/callback`;

    const installUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(SHOPIFY_CLIENT_ID)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    // IMPORTANT: un solo redirect, e poi return
    return res.redirect(installUrl);
  } catch (e) {
    console.error("/auth error:", e);
    return res.status(500).send("Auth start error");
  }
});

// ---------- 4) OAUTH CALLBACK ----------
app.get("/auth/callback", async (req, res) => {
  try {
    const { shop, code, state } = req.query;

    if (!isValidShop(shop)) return res.status(400).send("Invalid shop");
    if (!code || !state) return res.status(400).send("Missing code/state");

    const st = getState(state);
    if (!st || st.shop !== shop) {
      return res.status(400).send("Invalid/expired state");
    }

    // Verifica HMAC OAuth
    const okHmac = verifyOAuthHmac(req.query, SHOPIFY_CLIENT_SECRET);
    if (!okHmac) return res.status(400).send("HMAC validation failed");

    // Scambio code -> access_token
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenResp.ok) {
      const txt = await tokenResp.text().catch(() => "");
      console.error("Token exchange failed:", tokenResp.status, txt);
      return res.status(500).send("Token exchange failed");
    }

    const data = await tokenResp.json();
    const accessToken = data.access_token;
    if (!accessToken) return res.status(500).send("Missing access token");

    // Salva token (DB se presente, altrimenti fallback in-memory nel tuo db.js)
    await upsertShopToken(shop, accessToken);

    // Stato usato -> rimuovi
    delState(state);

    // Redirect finale (semplice)
    // Per ora mando alla pagina App in Shopify Admin (lista app)
    // Se vuoi dopo lo rendiamo embedded con App Bridge ecc.
    return res.redirect(`https://${shop}/admin/apps`);
  } catch (e) {
    console.error("/auth/callback error:", e);
    return res.status(500).send("Auth callback error");
  }
});

// ---------- Root ----------
app.get("/", (req, res) => {
  res.status(200).send(
    "Sync CarpeDiem - server online. Usa /auth?shop=TUO-SHOP.myshopify.com per installare."
  );
});

// ---------- Start ----------
(async () => {
  try {
    await initDb();
  } catch (e) {
    console.error("DB init error:", e);
  }

  const port = process.env.PORT || 10000;
  app.listen(port, () => {
    console.log("Server running on port", port);
    console.log("Primary URL:", SHOPIFY_APP_URL);
  });
})();
