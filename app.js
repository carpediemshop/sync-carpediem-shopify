import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";

import shopify from "./shopify.js"; // <— default export (compatibile anche con shopify.js “corto”)
import { verifyShopifyWebhook } from "./verifyShopifyWebhook.js";
import {
  upsertShopToken,
  getShopToken,
  upsertEbayLink,
  getEbayLinkBySku,
  listEbayLinks,
} from "./db.js";
import {
  createOrReplaceInventoryItem,
  updateInventoryQuantity,
  createOffer,
  publishOffer,
  updateOfferPriceQty,
} from "./ebay.js";

const app = express();
app.use(cookieParser());

/**
 * Webhook: serve RAW body per verifica HMAC.
 * IMPORTANTE: qui NON usare express.json() su /webhooks
 */
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/", (req, res) => res.send("OK sync-carpediem-shopify"));

/* ---------------------------
   SHOPIFY REST HELPERS
--------------------------- */

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

function adminBase(shop) {
  // shop atteso tipo: e9d9c4-38.myshopify.com
  return `https://${shop}/admin/api/${API_VERSION}`;
}

async function shopifyRest({ shop, accessToken, method, path, query, body }) {
  const url = new URL(adminBase(shop) + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg =
      (json && (json.errors || json.error || json.message)) ||
      (typeof json === "string" ? json : null) ||
      text ||
      `HTTP ${res.status}`;
    throw new Error(`Shopify REST ${method} ${path} -> ${res.status}: ${JSON.stringify(msg)}`);
  }

  return json;
}

async function listProducts(shop, accessToken, limit = 50) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: "/products.json",
    query: { limit },
  });
  return data.products || [];
}

async function getProductById(shop, accessToken, productId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/products/${productId}.json`,
  });
  return data.product;
}

async function getVariantById(shop, accessToken, variantId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: `/variants/${variantId}.json`,
  });
  return data.variant;
}

async function getMainLocationId(shop, accessToken) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: "/locations.json",
  });
  const locations = data.locations || [];
  const loc = locations.find((l) => l.active) || locations[0];
  if (!loc?.id) throw new Error("Nessuna location trovata su Shopify");
  return loc.id;
}

async function getInventoryLevel(shop, accessToken, inventoryItemId, locationId) {
  const data = await shopifyRest({
    shop,
    accessToken,
    method: "GET",
    path: "/inventory_levels.json",
    query: {
      inventory_item_ids: inventoryItemId,
      location_ids: locationId,
    },
  });
  const levels = data.inventory_levels || [];
  const level = levels[0];
  // Shopify può usare "available"
  const qty = Number(level?.available ?? 0);
  return Number.isFinite(qty) ? qty : 0;
}

/* ---------------------------
   1) INSTALL SHOPIFY
--------------------------- */
app.get("/auth", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send("Missing shop");

    // IMPORTANTISSIMO:
    // Con rawRequest/rawResponse, lo Shopify SDK può già scrivere la risposta.
    // NON fare res.redirect(redirectUrl) per evitare ERR_HTTP_HEADERS_SENT.
    await shopify.auth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
    return;
  } catch (e) {
    console.error("AUTH begin error:", e);
    return res.status(500).send("Auth error: " + String(e.message || e));
  }
});

/* ---------------------------
   2) CALLBACK
--------------------------- */
app.get("/auth/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    await upsertShopToken({
      shop: session.shop,
      accessToken: session.accessToken,
      scope: session.scope,
    });

    await registerWebhooks(session.shop, session.accessToken);

    // redirect UI
    res.redirect(`/app?shop=${encodeURIComponent(session.shop)}`);
  } catch (e) {
    console.error("AUTH callback error:", e);
    return res.status(500).send("Callback error: " + String(e.message || e));
  }
});

/** Registra webhooks */
async function registerWebhooks(shop, accessToken) {
  const base = process.env.SHOPIFY_APP_URL;
  if (!base) {
    console.log("WARN: SHOPIFY_APP_URL mancante, salto registrazione webhook");
    return;
  }

  const hooks = [{ topic: "products/update", address: `${base}/webhooks/products-update` }];

  for (const h of hooks) {
    try {
      await shopifyRest({
        shop,
        accessToken,
        method: "POST",
        path: "/webhooks.json",
        body: { webhook: { topic: h.topic, address: h.address, format: "json" } },
      });
    } catch (e) {
      console.log("Webhook register failed:", h.topic, String(e.message || e));
    }
  }
}

/* ---------------------------
   3) MINI UI
--------------------------- */
app.get("/app", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <html>
      <head><meta charset="utf-8"><title>Sync eBay</title></head>
      <body style="font-family: Arial; padding: 16px;">
        <h2>Sync eBay - ${shop}</h2>
        <p>1) <b>Lista prodotti Shopify</b> con pulsante Publish</p>
        <a href="/app/products?shop=${encodeURIComponent(shop)}">Apri lista prodotti</a>

        <p style="margin-top:20px;">2) <b>Link DB</b> (debug)</p>
        <a href="/api/links?shop=${encodeURIComponent(shop)}" target="_blank">Vedi JSON links</a>
      </body>
    </html>
  `);
});

/** Lista prodotti Shopify con bottone Publish */
app.get("/app/products", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send("Missing shop");

    const accessToken = await getShopToken(shop);
    if (!accessToken)
      return res
        .status(401)
        .send('App non installata su questo shop. Installa: /auth?shop=...');

    const products = await listProducts(shop, accessToken, 50);

    let rows = "";
    for (const p of products) {
      const v = (p.variants || [])[0];
      if (!v) continue;
      rows += `
        <tr>
          <td>${p.title}</td>
          <td>${v.sku || ""}</td>
          <td>${v.price}</td>
          <td><button onclick="publish(${p.id}, ${v.id})">Pubblica su eBay</button></td>
          <td id="st_${v.id}"></td>
        </tr>
      `;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <html>
        <head>
          <meta charset="utf-8">
          <title>Prodotti Shopify</title>
          <style>
            table{border-collapse:collapse;width:100%;}
            th,td{border:1px solid #ddd;padding:8px;font-size:14px;}
            th{background:#f5f5f5;}
            button{padding:6px 10px;cursor:pointer;}
          </style>
        </head>
        <body style="font-family: Arial; padding: 16px;">
          <h2>Prodotti Shopify (50) - ${shop}</h2>
          <table>
            <thead>
              <tr><th>Titolo</th><th>SKU</th><th>Prezzo</th><th>Azione</th><th>Stato</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>

          <script>
            const SHOP = ${JSON.stringify(shop)};

            async function publish(productId, variantId){
              const st = document.getElementById("st_" + variantId);
              st.innerText = "Pubblicazione in corso...";
              try{
                const res = await fetch("/api/ebay/publish", {
                  method:"POST",
                  headers:{"Content-Type":"application/json"},
                  body: JSON.stringify({ shop: SHOP, productId, variantId })
                });
                const data = await res.json();
                if(!res.ok) throw new Error(data.error || "Errore");
                st.innerText = "OK ✅ listingId=" + (data.listingId || "");
              }catch(e){
                st.innerText = "ERRORE ❌ " + e.message;
              }
            }
          </script>
        </body>
      </html>
    `);
  } catch (e) {
    console.error("Products page error:", e);
    res.status(500).send("Errore: " + String(e.message || e));
  }
});

/** Debug: lista links nel DB */
app.get("/api/links", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const token = await getShopToken(shop);
    if (!token) return res.status(401).json({ error: "App non installata su questo shop" });

    const rows = await listEbayLinks(shop, 200);
    res.json({ rows });
  } catch (e) {
    console.error("Links error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------------------------
   4) PUBBLICA SU EBAY
--------------------------- */
app.post("/api/ebay/publish", async (req, res) => {
  const { shop, productId, variantId } = req.body || {};
  if (!shop || !productId || !variantId)
    return res.status(400).json({ error: "Missing shop/productId/variantId" });

  const accessToken = await getShopToken(shop);
  if (!accessToken) return res.status(401).json({ error: "App non installata su questo shop" });

  try {
    const product = await getProductById(shop, accessToken, productId);
    const variant = await getVariantById(shop, accessToken, variantId);

    const sku = variant?.sku;
    if (!sku) throw new Error("SKU mancante sulla variante Shopify");

    const locationId = await getMainLocationId(shop, accessToken);
    const qty = await getInventoryLevel(shop, accessToken, variant.inventory_item_id, locationId);
    const price = Number(variant.price);

    const title = product.title;
    const description = (product.body_html || "").replace(/<[^>]+>/g, " ").trim().slice(0, 4000);
    const images = (product.images || []).map((i) => i.src).filter(Boolean);

    await upsertEbayLink({
      shop,
      shopifyProductId: product.id,
      shopifyVariantId: variant.id,
      sku,
      status: "linked",
    });

    await createOrReplaceInventoryItem({ sku, title, description, images });
    await updateInventoryQuantity({ sku, quantity: qty });

    const offerId = await createOffer({ sku, price, quantity: qty });
    const listingId = await publishOffer(offerId);

    await upsertEbayLink({
      shop,
      shopifyProductId: product.id,
      shopifyVariantId: variant.id,
      sku,
      ebayOfferId: offerId,
      ebayListingId: listingId,
      status: "published",
    });

    res.json({ ok: true, sku, offerId, listingId });
  } catch (e) {
    console.error("Publish error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------------------------
   5) WEBHOOK products/update
--------------------------- */
app.post("/webhooks/products-update", async (req, res) => {
  try {
    // req.body qui è Buffer (express.raw)
    req.rawBody = req.body;

    if (!verifyShopifyWebhook(req)) return res.status(401).send("Invalid HMAC");

    const shop = req.get("X-Shopify-Shop-Domain");
    const accessToken = await getShopToken(shop);
    if (!accessToken) return res.status(200).send("No token (ignored)");

    const payload = JSON.parse(req.body.toString("utf8"));
    const variants = payload.variants || [];

    const locationId = await getMainLocationId(shop, accessToken);

    for (const v of variants) {
      const sku = v.sku;
      if (!sku) continue;

      const link = await getEbayLinkBySku(shop, sku);
      if (!link?.ebay_offer_id) continue;

      try {
        const qty = await getInventoryLevel(shop, accessToken, v.inventory_item_id, locationId);
        const price = Number(v.price);
        await updateOfferPriceQty({ offerId: link.ebay_offer_id, price, quantity: qty });
      } catch (e) {
        console.error("eBay update failed:", sku, String(e.message || e));
      }
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(200).send("OK"); // Shopify vuole 200 per non ritentare all’infinito
  }
});

/* ---------------------------
   START SERVER
--------------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server listening on", port));

/* opzionale: evita crash “silenziosi” */
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
