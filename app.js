require("@shopify/shopify-api/adapters/node");
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const {
  initDb,
  upsertShopToken,
  getShopToken,
  createRun,
  addRunLog,
  finishRun,
  listRuns,
  getRunWithLogs,
} = require("./db");

const app = express();
app.set("trust proxy", 1);

app.use(bodyParser.json({ limit: "2mb" }));

// ---------- ENV ----------
const {
  SHOPIFY_APP_URL,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_WEBHOOK_SECRET,
} = process.env;

if (!SHOPIFY_APP_URL || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error(
    "Missing env. Required: SHOPIFY_APP_URL, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET"
  );
}

// Scopes (coerenti con Render ENV SHOPIFY_SCOPES se lo usi)
const SCOPES = ["read_products", "write_inventory", "read_orders"].join(",");

// ---------- helpers ----------
function isValidShop(shop) {
  return (
    typeof shop === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop)
  );
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

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
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

// CSP per embedded app in Shopify Admin
function setShopifyCsp(req, res) {
  const shop = req.query.shop;
  // admin.shopify.com (nuovo admin) + dominio shop
  if (isValidShop(shop)) {
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors https://${shop} https://admin.shopify.com;`
    );
  } else {
    res.setHeader("Content-Security-Policy", `frame-ancestors https://admin.shopify.com;`);
  }
  // Non bloccare iframe
  res.setHeader("X-Frame-Options", "ALLOWALL");
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

    const okHmac = verifyOAuthHmac(req.query, SHOPIFY_CLIENT_SECRET);
    if (!okHmac) return res.status(400).send("HMAC validation failed");

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

    await upsertShopToken(shop, accessToken);
    delState(state);

    // 🔥 redirect alla dashboard dell’app
    return res.redirect(`${SHOPIFY_APP_URL}/app?shop=${encodeURIComponent(shop)}`);
  } catch (e) {
    console.error("/auth/callback error:", e);
    return res.status(500).send("Auth callback error");
  }
});

// ---------- DASHBOARD UI ----------
app.get("/app", async (req, res) => {
  try {
    setShopifyCsp(req, res);

    const shop = req.query.shop;
    if (!isValidShop(shop)) return res.status(400).send("Missing/invalid shop");

    const token = await getShopToken(shop);
    if (!token) {
      return res
        .status(401)
        .send("App non installata o token mancante. Reinstalla: /auth?shop=e9d9c4-38.myshopify.com");
    }

    // Dashboard HTML (snella)
    return res.status(200).send(`<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Syncro Amazon-Ebay</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;background:#f6f6f7}
    .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
    .top{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:14px}
    .card{background:#fff;border:1px solid #e3e3e3;border-radius:12px;padding:14px}
    .grid{display:grid;grid-template-columns:1.2fr 1fr;gap:12px}
    .btn{border:1px solid #111;background:#111;color:#fff;border-radius:10px;padding:10px 12px;cursor:pointer}
    .btn2{border:1px solid #c9c9c9;background:#fff;color:#111;border-radius:10px;padding:10px 12px;cursor:pointer}
    .muted{color:#666;font-size:13px}
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px;border-bottom:1px solid #eee;font-size:14px;text-align:left}
    tr:hover{background:#fafafa;cursor:pointer}
    .pill{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;border:1px solid #ddd}
    .ok{border-color:#b7eb8f;background:#f6ffed}
    .err{border-color:#ffccc7;background:#fff2f0}
    .run{border-color:#d6e4ff;background:#f0f5ff}
    pre{white-space:pre-wrap;background:#0b1020;color:#d7e1ff;border-radius:10px;padding:12px;max-height:420px;overflow:auto}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .right{display:flex;gap:10px;align-items:center}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <div style="font-size:18px;font-weight:700">Syncro Amazon-Ebay</div>
        <div class="muted">Shop: <b>${shop}</b></div>
      </div>
      <div class="right">
        <button class="btn2" id="refreshBtn">Aggiorna</button>
        <button class="btn" id="syncBtn">Sync now</button>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div style="font-weight:700">Runs</div>
          <div class="muted" id="runsInfo">—</div>
        </div>
        <div style="margin-top:10px;overflow:auto">
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Trigger</th>
                <th>Stato</th>
              </tr>
            </thead>
            <tbody id="runsTbody">
              <tr><td colspan="3" class="muted">Caricamento…</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div style="font-weight:700">Logs</div>
          <div class="muted" id="logsInfo">Seleziona un run</div>
        </div>
        <div style="margin-top:10px">
          <pre id="logsPre">—</pre>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div style="font-weight:700;margin-bottom:6px">Azioni rapide</div>
      <div class="muted">
        • Se l’app risulta “vuota”, apri: <b>${SHOPIFY_APP_URL}/app?shop=${shop}</b><br/>
        • Installazione: <b>${SHOPIFY_APP_URL}/auth?shop=e9d9c4-38.myshopify.com</b>
      </div>
    </div>
  </div>

<script>
const SHOP = ${JSON.stringify(shop)};
const API = {
  runs: (shop) => \`/api/runs?shop=\${encodeURIComponent(shop)}\`,
  run: (id, shop) => \`/api/run/\${encodeURIComponent(id)}?shop=\${encodeURIComponent(shop)}\`,
  sync: () => \`/api/sync/run\`
};

function pill(status){
  const s = (status||"").toLowerCase();
  const cls = s==="success" ? "pill ok" : (s==="error" ? "pill err" : "pill run");
  return \`<span class="\${cls}">\${status}</span>\`;
}

function fmt(ts){
  try { return new Date(ts).toLocaleString(); } catch(e){ return ts; }
}

async function loadRuns(){
  const r = await fetch(API.runs(SHOP));
  const data = await r.json();
  const tbody = document.getElementById("runsTbody");
  document.getElementById("runsInfo").textContent = (data.runs?.length||0) + " runs";
  if(!data.runs || data.runs.length===0){
    tbody.innerHTML = '<tr><td colspan="3" class="muted">Nessun run ancora. Premi “Sync now”.</td></tr>';
    return;
  }
  tbody.innerHTML = data.runs.map(x => \`
    <tr data-runid="\${x.id}">
      <td>\${fmt(x.started_at)}</td>
      <td>\${x.trigger}</td>
      <td>\${pill(x.status)}</td>
    </tr>\`
  ).join("");
  [...tbody.querySelectorAll("tr[data-runid]")].forEach(tr=>{
    tr.addEventListener("click", ()=> loadRun(tr.dataset.runid));
  });
}

async function loadRun(runId){
  document.getElementById("logsInfo").textContent = "Caricamento logs…";
  const r = await fetch(API.run(runId, SHOP));
  const data = await r.json();
  const lines = [];
  lines.push("RUN: " + (data.run?.id || runId));
  lines.push("STATUS: " + (data.run?.status || "—"));
  lines.push("TRIGGER: " + (data.run?.trigger || "—"));
  lines.push("START: " + (data.run?.started_at ? fmt(data.run.started_at) : "—"));
  lines.push("END: " + (data.run?.finished_at ? fmt(data.run.finished_at) : "—"));
  lines.push("");
  lines.push("---- LOGS ----");
  (data.logs||[]).forEach(l=>{
    lines.push(\`[\${fmt(l.created_at)}] \${(l.level||"info").toUpperCase()}: \${l.message}\`);
  });
  document.getElementById("logsPre").textContent = lines.join("\\n");
  document.getElementById("logsInfo").textContent = "Run selezionato: " + runId;
}

async function syncNow(){
  document.getElementById("syncBtn").disabled = true;
  document.getElementById("syncBtn").textContent = "Sync in corso…";
  try{
    const r = await fetch(API.sync(), {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ shop: SHOP, trigger: "manual" })
    });
    const data = await r.json();
    await loadRuns();
    if(data.runId) await loadRun(data.runId);
  } finally {
    document.getElementById("syncBtn").disabled = false;
    document.getElementById("syncBtn").textContent = "Sync now";
  }
}

document.getElementById("refreshBtn").addEventListener("click", loadRuns);
document.getElementById("syncBtn").addEventListener("click", syncNow);

loadRuns();
</script>
</body>
</html>`);
  } catch (e) {
    console.error("/app error:", e);
    return res.status(500).send("Dashboard error");
  }
});

// ---------- API: runs ----------
app.get("/api/runs", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!isValidShop(shop)) return res.status(400).json({ error: "invalid shop" });

    const token = await getShopToken(shop);
    if (!token) return res.status(401).json({ error: "not installed" });

    const runs = await listRuns(shop, 30);
    return res.json({ runs });
  } catch (e) {
    console.error("/api/runs error:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ---------- API: single run + logs ----------
app.get("/api/run/:id", async (req, res) => {
  try {
    const shop = req.query.shop;
    const runId = req.params.id;
    if (!isValidShop(shop)) return res.status(400).json({ error: "invalid shop" });

    const token = await getShopToken(shop);
    if (!token) return res.status(401).json({ error: "not installed" });

    const data = await getRunWithLogs(runId, 400);

    // (extra sicurezza minimale) se il run non appartiene allo shop, non mostrarlo
    if (data.run && data.run.shop_domain && data.run.shop_domain !== shop) {
      return res.status(403).json({ error: "forbidden" });
    }

    return res.json({ run: data.run, logs: data.logs });
  } catch (e) {
    console.error("/api/run/:id error:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ---------- API: start sync (DEMO) ----------
app.post("/api/sync/run", async (req, res) => {
  try {
    const { shop, trigger = "manual" } = req.body || {};
    if (!isValidShop(shop)) return res.status(400).json({ error: "invalid shop" });

    const token = await getShopToken(shop);
    if (!token) return res.status(401).json({ error: "not installed" });

    const runId = await createRun({ shopDomain: shop, trigger, summary: { mode: "demo" } });
    await addRunLog(runId, { level: "info", message: "Sync avviata (demo)." });
    await addRunLog(runId, { level: "info", message: "Controllo token Shopify: OK" });
    await addRunLog(runId, { level: "info", message: "Step 1/3: lettura dati… (demo)" });
    await addRunLog(runId, { level: "info", message: "Step 2/3: confronto… (demo)" });
    await addRunLog(runId, { level: "info", message: "Step 3/3: aggiornamento… (demo)" });

    // qui poi agganceremo la vera sync Amazon/eBay
    await finishRun(runId, {
      status: "success",
      summary: { done: true, note: "Demo sync completed" },
    });

    await addRunLog(runId, { level: "info", message: "Sync completata con successo (demo)." });

    return res.json({ ok: true, runId });
  } catch (e) {
    console.error("/api/sync/run error:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ---------- Root ----------
app.get("/", (req, res) => {
  res.status(200).send(
    "Sync CarpeDiem - server online. Usa /auth?shop=e9d9c4-38.myshopify.com per installare. Dashboard: /app?shop=e9d9c4-38.myshopify.com"
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
