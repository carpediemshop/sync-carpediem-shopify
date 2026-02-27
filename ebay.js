import fetch from "node-fetch";

const EBAY_BASE =
  process.env.EBAY_ENV === "production"
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";

async function getEbayAccessToken() {
  const basic = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(`${EBAY_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.EBAY_REFRESH_TOKEN
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`eBay token error ${res.status}: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function ebayCall(path, { method = "GET", token, body, headers = {} }) {
  const res = await fetch(`${EBAY_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`eBay ${method} ${path} ${res.status}: ${text}`);
  return json;
}

// 1) Inventory item (SKU)
export async function createOrReplaceInventoryItem({ sku, title, description, images }) {
  const token = await getEbayAccessToken();

  const payload = {
    availability: { shipToLocationAvailability: { quantity: 0 } },
    condition: "NEW",
    product: {
      title,
      description,
      imageUrls: (images || []).slice(0, 12)
    }
  };

  await ebayCall(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    token,
    headers: { "Content-Language": "it-IT" },
    body: payload
  });
}

// 2) Aggiorna solo qty (inventory)
export async function updateInventoryQuantity({ sku, quantity }) {
  const token = await getEbayAccessToken();
  await ebayCall(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PATCH",
    token,
    body: {
      availability: { shipToLocationAvailability: { quantity } }
    }
  });
}

// 3) Create offer
export async function createOffer({ sku, price, quantity }) {
  const token = await getEbayAccessToken();

  const payload = {
    sku,
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || "EBAY_IT",
    format: "FIXED_PRICE",
    availableQuantity: quantity,
    categoryId: process.env.EBAY_DEFAULT_CATEGORY_ID,
    merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY || "default",
    pricingSummary: {
      price: { value: String(price), currency: process.env.EBAY_CURRENCY || "EUR" }
    },
    listingPolicies: {
      paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID,
      fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID,
      returnPolicyId: process.env.EBAY_RETURN_POLICY_ID
    }
  };

  const res = await ebayCall(`/sell/inventory/v1/offer`, {
    method: "POST",
    token,
    body: payload
  });

  return res.offerId;
}

// 4) Update offer price + qty
export async function updateOfferPriceQty({ offerId, price, quantity }) {
  const token = await getEbayAccessToken();

  await ebayCall(`/sell/inventory/v1/offer/${offerId}`, {
    method: "PUT",
    token,
    body: {
      availableQuantity: quantity,
      pricingSummary: {
        price: { value: String(price), currency: process.env.EBAY_CURRENCY || "EUR" }
      }
    }
  });
}

// 5) Publish
export async function publishOffer(offerId) {
  const token = await getEbayAccessToken();
  const res = await ebayCall(`/sell/inventory/v1/offer/${offerId}/publish`, {
    method: "POST",
    token
  });
  return res.listingId || null;
}
