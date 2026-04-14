/** Normaliza título de categoría para comparar sin acentos. */
export function normalizeCategoryName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Asigna cada categoría del panel a uno de tres bloques para TV.
 * Orden: deportes → películas (cine en directo) → el resto va al bloque «General» (id paises).
 */
export function liveCategoryBucket(categoryName) {
  const n = normalizeCategoryName(categoryName);
  if (
    /(^|[^a-z])deporte|deportes|\bsport|sports|futbol|football|futball|liga\s|nba\b|nfl\b|mlb\b|ufc\b|boxeo|tenis|golf|motor|racing|\bf1\b|formula|dazn|espn|\bgol\b|match|nhl|nascar|wwe|mma|olimp|champions|eurocopa|mundial|ligue|serie\s*a\b|premier|bundes|laliga|ucl\b|uel\b/i.test(
      n
    )
  ) {
    return "deportes";
  }
  if (
    /pelicula|peliculas|\bmovie|\bmovies|\bfilm|cinema|\bcine\b|vod|hbo|netflix|prime|disney|starz|showtime|24h|cinemax|ppv.*movie|movie.*ppv|pelis/i.test(
      n
    )
  ) {
    return "peliculas";
  }
  return "paises";
}

export const LIVE_TV_GROUPS = [
  {
    id: "deportes",
    label: "Deportes",
    hint: "Canales de deportes y competición",
  },
  {
    id: "peliculas",
    label: "Películas",
    hint: "Cine y canales de películas en directo",
  },
  {
    id: "paises",
    label: "General",
    hint: "Noticias, entretenimiento y resto de canales",
  },
];

export function categoryIdsForBucket(liveCats, bucketId) {
  return liveCats
    .filter((c) => liveCategoryBucket(c.category_name) === bucketId)
    .map((c) => String(c.category_id));
}

export function mergeStreamsById(streamLists) {
  const map = new Map();
  for (const list of streamLists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      const id = s?.stream_id;
      if (id == null) continue;
      if (!map.has(id)) map.set(id, s);
    }
  }
  return [...map.values()];
}
