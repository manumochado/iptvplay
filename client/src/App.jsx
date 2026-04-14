import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import VideoPlayer from "./VideoPlayer.jsx";
import { tryEnterPlaybackFullscreen } from "./fullscreen.js";
import {
  LIVE_TV_GROUPS,
  categoryIdsForBucket,
  mergeStreamsById,
} from "./liveBuckets.js";
import { channelInitials, posterForItem } from "./poster.js";

const tabs = [
  { id: "live", label: "Directo" },
  { id: "vod", label: "Películas" },
  { id: "series", label: "Series" },
];

function pickExt(item, fallback = "ts") {
  const e = item?.container_extension;
  if (e && typeof e === "string") return e.replace(/^\./, "");
  return fallback;
}

/** En directo casi siempre es HLS (.m3u8); el TS en bruto no va bien con <video> solo. */
function pickLiveExt(stream) {
  const ds = stream?.direct_source;
  if (typeof ds === "string" && /^https?:\/\//i.test(ds.trim())) {
    return { mode: "url", url: ds.trim() };
  }
  const raw = stream?.container_extension?.replace(/^\./, "").toLowerCase();
  if (raw === "m3u8" || raw === "hls") return { mode: "xtream", ext: "m3u8" };
  if (raw === "ts") return { mode: "xtream", ext: "ts" };
  if (raw) return { mode: "xtream", ext: raw };
  return { mode: "xtream", ext: "m3u8" };
}

function flattenEpisodes(seriesInfo) {
  const ep = seriesInfo?.episodes;
  if (!ep) return [];
  if (Array.isArray(ep)) return ep;
  const out = [];
  for (const season of Object.keys(ep).sort((a, b) => Number(a) - Number(b))) {
    const list = ep[season];
    if (Array.isArray(list)) {
      for (const it of list) {
        out.push({ ...it, season, season_num: season });
      }
    }
  }
  return out;
}

function seriesHeroUrl(s, mediaBase) {
  if (!s) return "";
  return posterForItem(s, "series", mediaBase || "");
}

export default function App() {
  const [tab, setTab] = useState("live");
  const [configured, setConfigured] = useState(null);
  const [mediaBase, setMediaBase] = useState("");
  const [userLabel, setUserLabel] = useState("");
  const [error, setError] = useState("");

  const [liveCats, setLiveCats] = useState([]);
  const [vodCats, setVodCats] = useState([]);
  const [serCats, setSerCats] = useState([]);

  const [catId, setCatId] = useState("");
  /** En Directo: null = inicio (3 bloques); deportes | peliculas | general (id interno paises) */
  const [liveBucket, setLiveBucket] = useState(null);
  const [items, setItems] = useState([]);
  const [loadingList, setLoadingList] = useState(false);

  const [seriesDetail, setSeriesDetail] = useState(null);
  const [episodes, setEpisodes] = useState([]);

  const [play, setPlay] = useState({ src: "", title: "" });
  const playerDockRef = useRef(null);

  const loadHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setConfigured(h.configured);
      setMediaBase(typeof h.mediaBase === "string" ? h.mediaBase : "");
      if (!h.configured) {
        setError(
          "Falta configuración: crea un archivo .env (ver .env.example) y reinicia npm run dev."
        );
      } else setError("");
    } catch (e) {
      setConfigured(false);
      setMediaBase("");
      setError(`No se pudo conectar con la API: ${e.message}. ¿Está el servidor en el puerto 3001?`);
    }
  }, []);

  const loadUser = useCallback(async () => {
    try {
      const u = await api.user();
      const name = u?.user_info?.username || u?.user_info?.auth || "";
      const exp = u?.user_info?.exp_date;
      setUserLabel(name ? `${name}${exp ? ` · exp ${exp}` : ""}` : "");
    } catch {
      setUserLabel("");
    }
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  useEffect(() => {
    if (!configured) return;
    loadUser();
    (async () => {
      try {
        const [lc, vc, sc] = await Promise.all([
          api.liveCategories(),
          api.vodCategories(),
          api.seriesCategories(),
        ]);
        setLiveCats(lc);
        setVodCats(vc);
        setSerCats(sc);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, [configured, loadUser]);

  const categories = useMemo(() => {
    if (tab === "vod") return vodCats;
    return serCats;
  }, [tab, vodCats, serCats]);

  const sectionLabel = useMemo(() => {
    if (tab === "live" && !liveBucket) return "Directo";
    if (tab === "live" && liveBucket) {
      const g = LIVE_TV_GROUPS.find((x) => x.id === liveBucket);
      return g ? `Canales · ${g.label}` : "Canales";
    }
    if (tab === "vod") return "Películas";
    return "Series";
  }, [tab, liveBucket]);

  useEffect(() => {
    setCatId("");
    setLiveBucket(null);
    setItems([]);
    setSeriesDetail(null);
    setEpisodes([]);
  }, [tab]);

  useEffect(() => {
    if (!configured) return;
    if (tab === "live" && !liveBucket) {
      setItems([]);
      setLoadingList(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingList(true);
      setError("");
      try {
        if (tab === "live" && liveBucket) {
          const ids = categoryIdsForBucket(liveCats, liveBucket);
          if (ids.length === 0) {
            if (!cancelled) setItems([]);
            return;
          }
          const lists = await Promise.all(ids.map((id) => api.liveStreams(id)));
          if (!cancelled) setItems(mergeStreamsById(lists));
        } else if (tab === "vod") {
          const data = await api.vodStreams(catId || undefined);
          if (!cancelled) setItems(data);
        } else {
          const data = await api.seriesList(catId || undefined);
          if (!cancelled) setItems(data);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, catId, configured, liveBucket, liveCats]);

  async function playLive(stream) {
    tryEnterPlaybackFullscreen(playerDockRef.current);
    try {
      const spec = pickLiveExt(stream);
      if (spec.mode === "url") {
        setPlay({ src: spec.url, title: stream.name });
        return;
      }
      const { url } = await api.streamUrl("live", stream.stream_id, spec.ext);
      setPlay({ src: url, title: stream.name });
    } catch (e) {
      setError(e.message);
    }
  }

  async function playVod(movie) {
    tryEnterPlaybackFullscreen(playerDockRef.current);
    try {
      const ext = pickExt(movie, "mp4");
      const { url } = await api.streamUrl("vod", movie.stream_id, ext);
      setPlay({ src: url, title: movie.name });
    } catch (e) {
      setError(e.message);
    }
  }

  async function openSeries(s) {
    setSeriesDetail(s);
    setEpisodes([]);
    try {
      const info = await api.seriesInfo(s.series_id);
      setEpisodes(flattenEpisodes(info));
    } catch (e) {
      setError(e.message);
    }
  }

  async function playEpisode(ep) {
    tryEnterPlaybackFullscreen(playerDockRef.current);
    try {
      const ext = pickExt(ep, "mp4");
      const sid = ep.id ?? ep.stream_id;
      const { url } = await api.streamUrl("series", sid, ext);
      const t = ep.title || `T${ep.season}E${ep.episode_num}`;
      setPlay({ src: url, title: `${seriesDetail?.name || "Serie"} — ${t}` });
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="nf-app">
      <header className="nf-header">
        <div className="nf-header-inner">
          <div className="nf-logo" aria-hidden>
            <span className="nf-logo-mark">I</span>
            <span className="nf-logo-rest">PTV</span>
          </div>
          <nav className="nf-nav" aria-label="Principal">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`nf-nav-item ${tab === t.id ? "is-active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="nf-header-actions">
            {userLabel ? <span className="nf-pill">{userLabel}</span> : null}
            <button type="button" className="nf-btn-outline" onClick={loadHealth}>
              Estado
            </button>
          </div>
        </div>
      </header>

      {error ? <div className="nf-banner nf-banner--err">{error}</div> : null}
      {configured === false && !error ? (
        <div className="nf-banner">Configura el archivo .env y reinicia el servidor.</div>
      ) : null}

      <div className="nf-stage">
        {tab === "live" && !liveBucket ? null : tab === "live" && liveBucket ? (
          <div className="nf-chips-wrap">
            <div className="nf-chips" role="tablist" aria-label="Directo">
              <button type="button" className="nf-chip is-active" onClick={() => setLiveBucket(null)}>
                ← Inicio directo
              </button>
            </div>
          </div>
        ) : (
          <div className="nf-chips-wrap">
            <div className="nf-chips" role="tablist" aria-label="Categorías">
              <button
                type="button"
                className={`nf-chip ${catId === "" ? "is-active" : ""}`}
                onClick={() => setCatId("")}
              >
                Todo
              </button>
              {categories.map((c) => (
                <button
                  key={c.category_id}
                  type="button"
                  className={`nf-chip ${String(catId) === String(c.category_id) ? "is-active" : ""}`}
                  onClick={() => setCatId(String(c.category_id))}
                >
                  {c.category_name}
                </button>
              ))}
            </div>
          </div>
        )}

        <section className="nf-content">
          {tab !== "series" || !seriesDetail ? (
            <>
              <h1 className="nf-section-title">
                {sectionLabel}
                {loadingList ? <span className="nf-loading">Cargando…</span> : null}
              </h1>
              {tab === "live" && !liveBucket ? (
                <p className="nf-live-hint">
                  Elige <strong>Deportes</strong>, <strong>Películas</strong> o <strong>General</strong>. Los
                  canales se agrupan automáticamente según las categorías del servidor.
                </p>
              ) : null}
              {tab === "live" && !liveBucket ? (
                <ul className="nf-cat-grid nf-cat-grid--three">
                  {LIVE_TV_GROUPS.map((g) => (
                    <li key={g.id}>
                      <button type="button" className="nf-cat-tile" onClick={() => setLiveBucket(g.id)}>
                        <span className="nf-cat-tile-inner">
                          <span className="nf-cat-tile-title">{g.label}</span>
                          <span className="nf-cat-tile-hint">{g.hint}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  <ul className="nf-poster-grid">
                    {items.map((it) => {
                      const poster = posterForItem(it, tab, mediaBase);
                      const key = it.stream_id || it.series_id;
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            className="nf-card"
                            onClick={() => {
                              if (tab === "live") playLive(it);
                              else if (tab === "vod") playVod(it);
                              else openSeries(it);
                            }}
                          >
                          <div className="nf-card-media">
                            <div className="nf-card-fallback" aria-hidden>
                              {channelInitials(it.name)}
                            </div>
                            {poster ? (
                              <img
                                className="nf-card-img"
                                src={poster}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                referrerPolicy="no-referrer"
                                onError={(e) => {
                                  e.currentTarget.classList.add("nf-card-img--fail");
                                }}
                              />
                            ) : null}
                            <div className="nf-card-gradient" />
                              <div className="nf-card-meta">
                                <div className="nf-card-title">{it.name}</div>
                                {it.rating ? <div className="nf-card-badge">★ {it.rating}</div> : null}
                              </div>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {tab === "live" && liveBucket && !loadingList && items.length === 0 ? (
                    <p className="nf-empty">
                      No hay canales en este grupo: el servidor no tiene categorías que coincidan, o aún se
                      están cargando.
                    </p>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <>
              <div className="nf-series-hero">
                {seriesHeroUrl(seriesDetail, mediaBase) ? (
                  <img
                    className="nf-series-poster"
                    src={seriesHeroUrl(seriesDetail, mediaBase)}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      e.currentTarget.style.visibility = "hidden";
                    }}
                  />
                ) : (
                  <div className="nf-series-poster" style={{ background: "#222" }} aria-hidden />
                )}
                <div className="nf-series-head">
                  <button type="button" className="nf-btn-back" onClick={() => setSeriesDetail(null)}>
                    ← Volver
                  </button>
                  <h1 className="nf-series-name">{seriesDetail.name}</h1>
                </div>
              </div>
              <h2 className="nf-section-title">Episodios</h2>
              <ul className="nf-episodes-grid">
                {episodes.map((ep) => (
                  <li key={ep.id}>
                    <button type="button" className="nf-episode-card" onClick={() => playEpisode(ep)}>
                      <div className="nf-episode-num">
                        T{ep.season} · E{ep.episode_num}
                      </div>
                      <div className="nf-episode-title">{ep.title || "Episodio"}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <footer ref={playerDockRef} className="nf-player-dock">
        <div className="nf-player-inner">
          {play.src ? (
            <VideoPlayer src={play.src} title={play.title} />
          ) : (
            <div className="nf-player-placeholder">Elige algo para reproducir.</div>
          )}
        </div>
      </footer>
    </div>
  );
}
