import crypto from "crypto";

export function verifyShopifyWebhook(req) {
  const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
  const body = req.rawBody; // Buffer

  const generated = crypto
    .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET)
    .update(body, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(hmac));
  } catch {
    return false;
  }
}
