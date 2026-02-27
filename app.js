import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";

import shopify from "./shopify.js";
import {
  shopifyRest,
  listProducts,
  getMainLocationId,
  getInventoryLevel,
  getProductById,
  getVariantById
} from "./shopify.js";

import { verifyShopifyWebhook } from "./verifyShopifyWebhook.js";

import {
  upsertShopToken,
  getShopToken,
  upsertEbayLink,
  getEbayLinkBySku,
  listEbayLinks
} from "./db.js";

import {
  createOrReplaceInventoryItem,
  updateInventoryQuantity,
  createOffer,
  publishOffer,
  updateOfferPriceQty
} from "./ebay.js";


const app = express();

app.use(cookieParser());

/* CRITICO: Shopify OAuth richiede cookies */
app.use(
  shopify.auth.begin({
    cookieOptions: {
      secure: true,
      sameSite: "none"
    }
  })
);

app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("OK sync-carpediem-shopify");
});


/* ========================================
   INSTALL APP
======================================== */

app.get("/auth", async (req, res) => {

  const shop = req.query.shop;

  if (!shop)
    return res.status(400).send("Missing shop");

  try {

    const redirectUrl = await shopify.auth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res
    });

    return res.redirect(redirectUrl);

  } catch (e) {

    console.error("AUTH ERROR:", e);

    res.status(500).send(String(e.message || e));

  }

});


/* ========================================
   CALLBACK
======================================== */

app.get("/auth/callback", async (req, res) => {

  try {

    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res
    });

    await upsertShopToken({
      shop: session.shop,
      accessToken: session.accessToken,
      scope: session.scope
    });

    await registerWebhooks(session.shop, session.accessToken);

    res.redirect(`/app?shop=${encodeURIComponent(session.shop)}`);

  }
  catch (e) {

    console.error("CALLBACK ERROR:", e);

    res.status(500).send("OAuth error: " + e.message);

  }

});


/* ========================================
   REGISTER WEBHOOK
======================================== */

async function registerWebhooks(shop, accessToken) {

  const base = process.env.SHOPIFY_APP_URL;

  try {

    await shopifyRest({
      shop,
      accessToken,
      method: "POST",
      path: "/webhooks.json",
      body: {
        webhook: {
          topic: "products/update",
          address: `${base}/webhooks/products-update`,
          format: "json"
        }
      }
    });

  } catch (e) {

    console.log("Webhook register error:", e.message);

  }

}


/* ========================================
   MINI UI
======================================== */

app.get("/app", async (req, res) => {

  const shop = req.query.shop;

  if (!shop)
    return res.status(400).send("Missing shop");

  res.send(`
  <html>
  <body style="font-family:Arial">

  <h2>Sync eBay</h2>

  <a href="/app/products?shop=${shop}">Lista prodotti</a>

  </body>
  </html>
  `);

});


/* ========================================
   LIST PRODUCTS
======================================== */

app.get("/app/products", async (req, res) => {

  const shop = req.query.shop;

  const accessToken = await getShopToken(shop);

  const products = await listProducts(shop, accessToken, 50);

  let html = "";

  for (const p of products) {

    const v = p.variants?.[0];

    if (!v) continue;

    html += `
      <tr>
        <td>${p.title}</td>
        <td>${v.sku || ""}</td>
        <td>${v.price}</td>
      </tr>
    `;
  }

  res.send(`
    <html>
    <body>

    <table border="1">

    ${html}

    </table>

    </body>
    </html>
  `);

});


/* ========================================
   WEBHOOK PRODUCTS UPDATE
======================================== */

app.post("/webhooks/products-update", async (req, res) => {

  req.rawBody = req.body;

  if (!verifyShopifyWebhook(req))
    return res.status(401).send("Invalid HMAC");

  const shop = req.get("X-Shopify-Shop-Domain");

  const accessToken = await getShopToken(shop);

  if (!accessToken)
    return res.status(200).send("ignored");

  const payload = JSON.parse(req.body.toString());

  for (const v of payload.variants || []) {

    const sku = v.sku;

    if (!sku) continue;

    const link = await getEbayLinkBySku(shop, sku);

    if (!link?.ebay_offer_id) continue;

    const locationId = await getMainLocationId(shop, accessToken);

    const qty = await getInventoryLevel(
      shop,
      accessToken,
      v.inventory_item_id,
      locationId
    );

    const price = Number(v.price);

    await updateOfferPriceQty({
      offerId: link.ebay_offer_id,
      price,
      quantity: qty
    });

  }

  res.send("OK");

});


/* ========================================
   START SERVER
======================================== */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () =>
  console.log("Server listening on port", PORT)
);
