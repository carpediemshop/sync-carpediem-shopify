import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";

import { shopify, shopifyRest, listProducts, getMainLocationId, getInventoryLevel, getProductById, getVariantById } from "./shopify.js";
import { verifyShopifyWebhook } from "./verifyShopifyWebhook.js";
import { upsertShopToken, getShopToken, upsertEbayLink, getEbayLinkBySku, listEbayLinks } from "./db.js";
import { createOrReplaceInventoryItem, updateInventoryQuantity, createOffer, publishOffer, updateOfferPriceQty } from "./ebay.js";

const app = express();
app.use(cookieParser());

// Webhook: raw body (serve per HMAC)
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/", (req, res) => res.send("OK sync-carpediem-shopify"));

/** 1) INSTALL SHOPIFY */
app.get("/auth", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop");

  const redirectUrl = await shopify.auth.begin({
    shop,
    callbackPath: "/auth/callback",
    isOnline: false,
    rawRequest: req,
    rawResponse: res
  });

  return res.redirect(redirectUrl);
});

/** 2) CALLBACK */
app.get("/auth/callback", async (req, res) => {
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
});

/** Registra webhooks */
async function registerWebhooks(shop, accessToken) {
  const base = process.env.SHOPIFY_APP_URL;
  const hooks = [
    { topic: "products/update", address: `${base}/webhooks/products-update` }
  ];

  for (const h of hooks) {
    try {
      await shopifyRest({
        shop,
        accessToken,
        method: "POST",
        path: "/webhooks.json",
        body: { webhook: { topic: h.topic, address: h.address, format: "json" } }
      });
    } catch (e) {
      console.log("Webhook register:", h.topic, String(e.message));
    }
  }
}

/** 3) MINI UI (pagina semplice) */
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
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop");

  const accessToken = await getShopToken(shop);
  if (!accessToken) return res.status(401).send("App non installata su questo shop. Installa: /auth?shop=...");

  const products = await listProducts(shop, accessToken, 50);

  // tabella semplice: solo prima variante per prodotto (poi la estendiamo a tutte)
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
});

/** Debug: lista links nel DB */
app.get("/api/links", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const token = await getShopToken(shop);
  if (!token) return res.status(401).json({ error: "App non installata su questo shop" });

  const rows = await listEbayLinks(shop, 200);
  res.json({ rows });
});

/** 4) PUBBLICA SU EBAY (chiamato dal bottone) */
app.post("/api/ebay/publish", async (req, res) => {
  const { shop, productId, variantId } = req.body || {};
  if (!shop || !productId || !variantId) return res.status(400).json({ error: "Missing shop/productId/variantId" });

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
    const images = (product.images || []).map(i => i.src).filter(Boolean);

    // salva mapping base
    await upsertEbayLink({
      shop,
      shopifyProductId: product.id,
      shopifyVariantId: variant.id,
      sku,
      status: "linked"
    });

    // crea inventory item
    await createOrReplaceInventoryItem({ sku, title, description, images });

    // set qty
    await updateInventoryQuantity({ sku, quantity: qty });

    // create offer + publish
    const offerId = await createOffer({ sku, price, quantity: qty });
    const listingId = await publishOffer(offerId);

    await upsertEbayLink({
      shop,
      shopifyProductId: product.id,
      shopifyVariantId: variant.id,
      sku,
      ebayOfferId: offerId,
      ebayListingId: listingId,
      status: "published"
    });

    res.json({ ok: true, sku, offerId, listingId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** 5) WEBHOOK: quando cambia prodotto (prezzo o altro) → aggiorna eBay */
app.post("/webhooks/products-update", async (req, res) => {
  req.rawBody = req.body;
  if (!verifyShopifyWebhook(req)) return res.status(401).send("Invalid HMAC");

  const shop = req.get("X-Shopify-Shop-Domain");
  const accessToken = await getShopToken(shop);
  if (!accessToken) return res.status(200).send("No token (ignored)");

  const payload = JSON.parse(req.body.toString("utf8"));
  const variants = payload.variants || [];

  for (const v of variants) {
    const sku = v.sku;
    if (!sku) continue;

    const link = await getEbayLinkBySku(shop, sku);
    if (!link?.ebay_offer_id) continue;

    try {
      const locationId = await getMainLocationId(shop, accessToken);
      const qty = await getInventoryLevel(shop, accessToken, v.inventory_item_id, locationId);
      const price = Number(v.price);

      await updateOfferPriceQty({ offerId: link.ebay_offer_id, price, quantity: qty });
    } catch (e) {
      console.error("eBay update failed:", sku, String(e.message));
    }
  }

  res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server listening on", port));
