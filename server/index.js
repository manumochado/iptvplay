import dns from "node:dns";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { fetch as undiciFetch, Agent } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envRoot = path.join(__dirname, "..", ".env");
const envServer = path.join(__dirname, ".env");
if (fs.existsSync(envServer)) dotenv.config({ path: envServer });
if (fs.existsSync(envRoot)) dotenv.config({ path: envRoot, override: true });

function stripQuotes(s) {
  if (!s || typeof s !== "string") return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

const IPTV_BASE_URL = stripQuotes(process.env.IPTV_BASE_URL);
const IPTV_USERNAME = stripQuotes(process.env.IPTV_USERNAME);
const IPTV_PASSWORD = stripQuotes(process.env.IPTV_PASSWORD);

const tlsInsecure = process.env.IPTV_TLS_INSECURE === "1";
const preferIpv4 = process.env.IPTV_IPV4 !== "0";

const connectOpts = {
  rejectUnauthorized: !tlsInsecure,
};
if (preferIpv4) {
  connectOpts.lookup = (hostname, _opts, cb) => {
    dns.lookup(hostname, { family: 4, all: false }, cb);
  };
}

/** Agente HTTP(S) para el panel: timeouts, IPv4 (útil en Railway) y TLS opcional. */
const xtreamAgent = new Agent({
  connect: connectOpts,
  connectTimeout: Number(process.env.IPTV_CONNECT_TIMEOUT_MS || 60000),
  bodyTimeout: Number(process.env.IPTV_BODY_TIMEOUT_MS || 120000),
});

/** Si HTTPS falla y responde por HTTP, reutilizamos http para streams. */
let resolvedBaseUrlOverride = null;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

function requireConfig(res) {
  if (!IPTV_BASE_URL || !IPTV_USERNAME || !IPTV_PASSWORD) {
    res.status(500).json({
      error:
        "Falta configuración. Copia .env.example a .env y define IPTV_BASE_URL, IPTV_USERNAME e IPTV_PASSWORD.",
    });
    return false;
  }
  return true;
}

function baseUrl() {
  const raw = resolvedBaseUrlOverride || IPTV_BASE_URL;
  return raw.replace(/\/$/, "");
}

function buildXtreamUrl(params) {
  const u = new URL(`${baseUrl()}/player_api.php`);
  u.searchParams.set("username", IPTV_USERNAME);
  u.searchParams.set("password", IPTV_PASSWORD);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function sslLooksLikePlainHttp(err) {
  const parts = [err?.message, err?.cause?.message, err?.cause?.code].filter(Boolean).join(" ");
  return /WRONG_VERSION_NUMBER|wrong version number|EPROTO|SSL.*alert|certificate/i.test(parts);
}

async function xtream(params) {
  let url = buildXtreamUrl(params);
  const fetchOpts = {
    headers: { Accept: "application/json" },
    dispatcher: xtreamAgent,
  };

  let r;
  let text;
  try {
    r = await undiciFetch(url, fetchOpts);
    text = await r.text();
  } catch (e) {
    if (url.startsWith("https:") && sslLooksLikePlainHttp(e)) {
      const httpUrl = url.replace(/^https:/, "http:");
      console.warn(
        "[iptv] HTTPS falló (suele ser HTTP en ese puerto). Reintentando con HTTP:",
        httpUrl.split("?")[0]
      );
      r = await undiciFetch(httpUrl, fetchOpts);
      text = await r.text();
      resolvedBaseUrlOverride = IPTV_BASE_URL.replace(/^https:/i, "http:");
    } else {
      const code = e.cause?.code ? ` [${e.cause.code}]` : "";
      console.error("[iptv] fetch error:", e.message, e.cause || "");
      throw new Error(
        `No se pudo conectar al panel IPTV: ${e.message}${code}. Comprueba IPTV_BASE_URL (http vs https). En Railway muchos proveedores bloquean IPs de hosting: prueba IPTV_TLS_INSECURE=1 o despliega en un VPS con IP distinta.`
      );
    }
  }

  if (!r.ok) {
    const hint =
      r.status === 403
        ? " (403 suele indicar que el panel bloquea la IP del servidor, típico en Railway/hosting)"
        : "";
    console.error("[iptv] HTTP", r.status, url.split("?")[0]);
    throw new Error(
      `El panel respondió HTTP ${r.status}${hint}. Cuerpo: ${String(text || "").slice(0, 180)}`
    );
  }

  if (!text || !String(text).trim()) {
    throw new Error(
      `Respuesta vacía (${r.status}) desde el panel. Revisa IPTV_BASE_URL y que el servidor exponga player_api.php.`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta no JSON (${r.status}): ${text.slice(0, 200)}`);
  }
}

app.get("/api/health", (_req, res) => {
  const configured = Boolean(IPTV_BASE_URL && IPTV_USERNAME && IPTV_PASSWORD);
  const mediaBase = configured && IPTV_BASE_URL ? baseUrl() : null;
  res.json({ ok: true, configured, mediaBase });
});

app.get("/api/user", async (req, res) => {
  if (!requireConfig(res)) return;
  try {
    const data = await xtream({});
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/live/categories", async (_req, res) => {
  if (!requireConfig(res)) return;
  try {
    const data = await xtream({ action: "get_live_categories" });
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/live/streams", async (req, res) => {
  if (!requireConfig(res)) return;
  const categoryId = req.query.category_id;
  try {
    const data = await xtream({
      action: "get_live_streams",
      ...(categoryId ? { category_id: categoryId } : {}),
    });
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/vod/categories", async (_req, res) => {
  if (!requireConfig(res)) return;
  try {
    const data = await xtream({ action: "get_vod_categories" });
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/vod/streams", async (req, res) => {
  if (!requireConfig(res)) return;
  const categoryId = req.query.category_id;
  try {
    const data = await xtream({
      action: "get_vod_streams",
      ...(categoryId ? { category_id: categoryId } : {}),
    });
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/series/categories", async (_req, res) => {
  if (!requireConfig(res)) return;
  try {
    const data = await xtream({ action: "get_series_categories" });
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/series/list", async (req, res) => {
  if (!requireConfig(res)) return;
  const categoryId = req.query.category_id;
  try {
    const data = await xtream({
      action: "get_series",
      ...(categoryId ? { category_id: categoryId } : {}),
    });
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/series/info", async (req, res) => {
  if (!requireConfig(res)) return;
  const seriesId = req.query.series_id;
  if (!seriesId) return res.status(400).json({ error: "series_id requerido" });
  try {
    const data = await xtream({ action: "get_series_info", series_id: seriesId });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** URL de reproducción Xtream Codes */
app.get("/api/stream-url", (req, res) => {
  if (!requireConfig(res)) return;
  const type = req.query.type;
  const streamId = req.query.stream_id;
  const ext = (req.query.ext || "ts").replace(/^\./, "");
  if (!type || !streamId) {
    return res.status(400).json({ error: "type y stream_id requeridos" });
  }
  const b = baseUrl();
  const user = encodeURIComponent(IPTV_USERNAME);
  const pass = encodeURIComponent(IPTV_PASSWORD);
  const id = encodeURIComponent(streamId);
  let path;
  if (type === "live") path = `/live/${user}/${pass}/${id}.${ext}`;
  else if (type === "vod") path = `/movie/${user}/${pass}/${id}.${ext}`;
  else if (type === "series") path = `/series/${user}/${pass}/${id}.${ext}`;
  else return res.status(400).json({ error: "type debe ser live, vod o series" });
  const url = `${b}${path}`;
  res.json({ url });
});

const distPath = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distPath, "index.html"), (err) => {
      if (err) next(err);
    });
  });
}

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`IPTV app en http://${HOST}:${PORT}`);
});
