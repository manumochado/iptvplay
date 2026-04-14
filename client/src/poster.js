export function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Une URL relativa del panel con la base del servidor (p. ej. /images/x.png).
 */
export function resolvePosterUrl(raw, mediaBase) {
  let u = firstNonEmpty(raw);
  if (!u) return "";
  if (u.startsWith("//")) u = `https:${u}`;
  if (/^https?:\/\//i.test(u)) return u;
  if (!mediaBase) return u;
  const base = mediaBase.endsWith("/") ? mediaBase : `${mediaBase}/`;
  try {
    if (u.startsWith("/")) return new URL(u.slice(1), base).href;
    if (!/^https?:\/\//i.test(u)) return new URL(u, base).href;
  } catch {
    /* noop */
  }
  return u;
}

export function rawPosterFromItem(it, tab) {
  if (tab === "live") {
    return firstNonEmpty(
      it.stream_icon,
      it.icon,
      it.logo,
      it.image,
      it.cover,
      it.channel_icon,
      it.thumbnail
    );
  }
  if (tab === "vod") {
    return firstNonEmpty(
      it.stream_icon,
      it.cover,
      it.movie_image,
      it.backdrop_path,
      it.icon,
      it.image
    );
  }
  return firstNonEmpty(it.cover_big, it.cover, it.stream_icon, it.backdrop_path, it.icon, it.image);
}

export function posterForItem(it, tab, mediaBase) {
  return resolvePosterUrl(rawPosterFromItem(it, tab), mediaBase);
}

/** Iniciales para avatar cuando no hay icono o falla la carga. */
export function channelInitials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const alnum = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const parts = alnum.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0].charAt(0);
    const b = parts[1].charAt(0);
    return `${a}${b}`.toUpperCase().slice(0, 3);
  }
  return alnum.slice(0, 2).toUpperCase() || "?";
}
