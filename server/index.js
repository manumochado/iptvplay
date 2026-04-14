import dns from "node:dns";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
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
const IPTV_API_PATH = stripQuotes(process.env.IPTV_API_PATH || "/player_api.php");
const ALLOW_EXTERNAL_PROXY = process.env.IPTV_ALLOW_EXTERNAL_PROXY === "1";

const debugAuth = process.env.IPTV_DEBUG_AUTH === "1";
const logSecrets = process.env.IPTV_LOG_SECRETS === "1";
const tlsInsecure = process.env.IPTV_TLS_INSECURE === "1";
const preferIpv4 = process.env.IPTV_IPV4 !== "0";

function maskSecret(s) {
  if (!s) return "(vacío)";
  if (s.length <= 2) return "*".repeat(s.length);
  return `${s[0]}${"*".repeat(Math.max(1, s.length - 2))}${s[s.length - 1]}`;
}

function logAuthSnapshot(reason) {
  if (!debugAuth) return;
  const safe = {
    reason,
    base_url: IPTV_BASE_URL,
    username: logSecrets ? IPTV_USERNAME : maskSecret(IPTV_USERNAME),
    password: logSecrets ? IPTV_PASSWORD : maskSecret(IPTV_PASSWORD),
    username_len: IPTV_USERNAME?.length || 0,
    password_len: IPTV_PASSWORD?.length || 0,
    tls_insecure: tlsInsecure,
    ipv4_forced: preferIpv4,
  };
  console.warn("[iptv][auth-debug]", safe);
}

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
/** Si la ruta API inicial falla, fijamos la alternativa que sí responde JSON. */
let resolvedApiPathOverride = null;

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

function apiPath() {
  const p = (resolvedApiPathOverride || IPTV_API_PATH).trim();
  if (!p) return "/player_api.php";
  return p.startsWith("/") ? p : `/${p}`;
}

function apiPathCandidates() {
  const list = [apiPath(), "/player_api.php", "/panel_api.php"];
  return [...new Set(list)];
}

function buildXtreamUrl(params, pathOverride = apiPath()) {
  const u = new URL(`${baseUrl()}${pathOverride}`);
  u.searchParams.set("username", IPTV_USERNAME);
  u.searchParams.set("password", IPTV_PASSWORD);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function safeUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isProxyTargetAllowed(target) {
  const u = safeUrl(target);
  if (!u) return false;
  if (!["http:", "https:"].includes(u.protocol)) return false;
  if (ALLOW_EXTERNAL_PROXY) return true;
  const base = safeUrl(baseUrl());
  if (!base) return false;
  return u.hostname === base.hostname;
}

function proxifyTarget(target) {
  return `/api/stream-proxy?target=${encodeURIComponent(target)}`;
}

function rewriteM3u8(body, sourceUrl) {
  const lines = String(body).split(/\r?\n/);
  return lines
    .map((line) => {
      const raw = line.trim();
      if (!raw) return line;
      // #EXT-X-KEY / #EXT-X-MAP suelen llevar URI="..."
      if (raw.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          const abs = safeUrl(uri) ? uri : new URL(uri, sourceUrl).toString();
          return `URI="${proxifyTarget(abs)}"`;
        });
      }
      const abs = safeUrl(raw) ? raw : new URL(raw, sourceUrl).toString();
      return proxifyTarget(abs);
    })
    .join("\n");
}

function sslLooksLikePlainHttp(err) {
  const parts = [err?.message, err?.cause?.message, err?.cause?.code].filter(Boolean).join(" ");
  return /WRONG_VERSION_NUMBER|wrong version number|EPROTO|SSL.*alert|certificate/i.test(parts);
}

async function xtream(params) {
  const fetchOpts = {
    headers: { Accept: "application/json" },
    dispatcher: xtreamAgent,
  };

  const candidates = apiPathCandidates();
  let lastErr = null;

  for (const candidatePath of candidates) {
    let url = buildXtreamUrl(params, candidatePath);
    let r;
    let text;

    try {
      r = await undiciFetch(url, fetchOpts);
      text = await r.text();
    } catch (e) {
      if (url.startsWith("https:") && sslLooksLikePlainHttp(e)) {
        const httpUrl = url.replace(/^https:/, "http:");
        console.warn(
          "[iptv] HTTPS fallo (suele ser HTTP en ese puerto). Reintentando con HTTP:",
          httpUrl.split("?")[0]
        );
        r = await undiciFetch(httpUrl, fetchOpts);
        text = await r.text();
        resolvedBaseUrlOverride = IPTV_BASE_URL.replace(/^https:/i, "http:");
      } else {
        const code = e.cause?.code ? ` [${e.cause.code}]` : "";
        lastErr =
          `No se pudo conectar al panel IPTV: ${e.message}${code}. ` +
          `Comprueba IPTV_BASE_URL (http vs https) y IPTV_API_PATH (${apiPath()}).`;
        continue;
      }
    }

    if (!r.ok) {
      const hint =
        r.status === 403
          ? " (403 suele indicar que el panel bloquea la IP del servidor, típico en Railway/hosting)"
          : "";
      const msg = `El panel respondio HTTP ${r.status}${hint}. Cuerpo: ${String(text || "").slice(0, 180)}`;
      lastErr = msg;
      continue;
    }

    if (!text || !String(text).trim()) {
      lastErr = `Respuesta vacia (${r.status}) desde el panel en ${candidatePath}.`;
      continue;
    }

    const body = String(text).trim();
    const panelErr = interpretPanelNonJsonBody(body);
    if (panelErr) {
      // Si es error de ruta, intentamos la siguiente candidata.
      if (panelErr.toLowerCase().includes("url del panel/api incorrecta")) {
        lastErr = panelErr;
        continue;
      }
      throw new Error(panelErr);
    }

    try {
      const json = JSON.parse(body);
      if (candidatePath !== resolvedApiPathOverride) {
        resolvedApiPathOverride = candidatePath;
        console.warn("[iptv] Ruta API detectada automaticamente:", resolvedApiPathOverride);
      }
      return json;
    } catch {
      const preview = body.slice(0, 200);
      const looksHtml = /<\s*!?\s*html/i.test(body);
      lastErr = looksHtml
        ? `El panel devolvio HTML en ${candidatePath} en lugar de JSON. Vista previa: ${preview}`
        : `Respuesta no JSON (${r.status}) en ${candidatePath}: ${preview}`;
      continue;
    }
  }

  throw new Error(
    lastErr ||
      `No se pudo obtener JSON del panel. Rutas probadas: ${apiPathCandidates().join(", ")}`
  );
}

/** El host a veces responde 200 con texto/HTML de error en lugar de JSON Xtream. */
function interpretPanelNonJsonBody(s) {
  const t = s.toLowerCase();
  if (t.includes("invalid authorization") || t.includes("invalid user") || t.includes("banned")) {
    logAuthSnapshot("invalid authorization");
    return (
      "El panel rechaza el acceso (usuario, contraseña o URL incorrectos). " +
      "Revisa IPTV_USERNAME e IPTV_PASSWORD en Railway (sin comillas ni espacios de más) " +
      "y IPTV_BASE_URL exactamente como te dio el proveedor (ej. http://dominio:8080, sin barra final)."
    );
  }
  if (/\b404\b/.test(t) && (t.includes("error") || t.includes("url"))) {
    return (
      "URL del panel/API incorrecta (404). IPTV_BASE_URL debe ser solo host:puerto (sin rutas), " +
      `y la ruta API correcta en IPTV_API_PATH (actual: ${apiPath()}).`
    );
  }
  if (t.includes("server under maintenance") || t.includes("maintenance")) {
    return "Panel del proveedor en mantenimiento; inténtalo más tarde.";
  }
  return null;
}

app.get("/api/health", (_req, res) => {
  const configured = Boolean(IPTV_BASE_URL && IPTV_USERNAME && IPTV_PASSWORD);
  const mediaBase = configured && IPTV_BASE_URL ? baseUrl() : null;
  res.json({ ok: true, configured, mediaBase, apiPath: apiPath() });
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

/** Proxy de streams para evitar mixed-content (HTTPS app -> HTTP IPTV). */
app.get("/api/stream-proxy", async (req, res) => {
  const target = req.query.target;
  if (!target || typeof target !== "string") {
    return res.status(400).json({ error: "target requerido" });
  }
  if (!isProxyTargetAllowed(target)) {
    return res.status(403).json({
      error:
        "target no permitido para proxy. Si necesitas dominios externos (direct_source), activa IPTV_ALLOW_EXTERNAL_PROXY=1.",
    });
  }
  try {
    const upstream = await undiciFetch(target, {
      dispatcher: xtreamAgent,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      },
    });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => "");
      return res
        .status(upstream.status)
        .send(txt || `stream proxy upstream error ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type") || "";
    const finalUrl = upstream.url || target;
    const isM3u8 =
      /\.m3u8(\?|$)/i.test(finalUrl) ||
      /application\/(vnd\.apple\.mpegurl|x-mpegurl)/i.test(contentType);

    res.setHeader("cache-control", "no-store");
    res.setHeader("access-control-allow-origin", "*");

    if (isM3u8) {
      const text = await upstream.text();
      const rewritten = rewriteM3u8(text, finalUrl);
      res.setHeader("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
      return res.status(upstream.status).send(rewritten);
    }

    if (contentType) res.setHeader("content-type", contentType);
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("content-length", len);
    const body = upstream.body;
    if (!body) return res.status(502).send("upstream stream vacío");
    Readable.fromWeb(body).pipe(res);
  } catch (e) {
    res.status(502).json({ error: `stream proxy error: ${e.message}` });
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
  logAuthSnapshot("startup");
  if (debugAuth && logSecrets) {
    console.warn("[iptv][auth-debug] IPTV_LOG_SECRETS=1 activo: desactivalo tras diagnosticar.");
  }
});
