async function j(path, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const r = await fetch(path, { signal: controller.signal }).finally(() => clearTimeout(t));
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* cuerpo no JSON */
  }
  if (!r.ok) {
    throw new Error(data.error || text?.slice(0, 400) || `${r.status} ${r.statusText}`);
  }
  return data;
}

export const api = {
  health: () => j("/api/health"),
  user: () => j("/api/user"),
  liveCategories: () => j("/api/live/categories"),
  liveStreams: (categoryId) =>
    j(`/api/live/streams${categoryId ? `?category_id=${encodeURIComponent(categoryId)}` : ""}`, 12000),
  vodCategories: () => j("/api/vod/categories"),
  vodStreams: (categoryId) =>
    j(`/api/vod/streams${categoryId ? `?category_id=${encodeURIComponent(categoryId)}` : ""}`),
  seriesCategories: () => j("/api/series/categories"),
  seriesList: (categoryId) =>
    j(`/api/series/list${categoryId ? `?category_id=${encodeURIComponent(categoryId)}` : ""}`),
  seriesInfo: (seriesId) => j(`/api/series/info?series_id=${encodeURIComponent(seriesId)}`),
  streamUrl: (type, streamId, ext = "ts") =>
    j(
      `/api/stream-url?type=${encodeURIComponent(type)}&stream_id=${encodeURIComponent(streamId)}&ext=${encodeURIComponent(ext)}`
    ),
};
