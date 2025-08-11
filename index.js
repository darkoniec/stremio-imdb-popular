import axios from "axios";
import * as cheerio from "cheerio";
import NodeCache from "node-cache";
import sdk from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = sdk;

const TTL_SECONDS = 60 * 60 * 6; // 6h cache
const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 120 });

const OMDB_API_KEY = process.env.OMDB_API_KEY || "";

// Map each catalog id to its IMDb source page
const SOURCES = {
  "imdb-popular-movies": { url: "https://www.imdb.com/chart/moviemeter/", type: "movie" },
  "imdb-popular-series": { url: "https://www.imdb.com/chart/tvmeter/", type: "series" },
  "imdb-top250-movies":  { url: "https://www.imdb.com/chart/top/", type: "movie" },
  "imdb-top250-series":  { url: "https://www.imdb.com/chart/toptv/", type: "series" }
};

const manifest = {
  id: "dev.imdb.popular",
  version: "1.3.3",
  name: "IMDb Popular + Top 250 (Unofficial)",
  description:
    "IMDb 'Most Popular' & 'Top 250' Movies/TV as Stremio catalogs. Uses Cinemeta; OMDb fallback injects titles/posters.",
  resources: ["catalog"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    { type: "movie",  id: "imdb-popular-movies", name: "IMDb Most Popular Movies", extra: [] },
    { type: "series", id: "imdb-popular-series", name: "IMDb Most Popular TV",     extra: [] },
    { type: "movie",  id: "imdb-top250-movies",  name: "IMDb Top 250 Movies",       extra: [] },
    { type: "series", id: "imdb-top250-series",  name: "IMDb Top 250 TV",           extra: [] }
  ]
};

const builder = new addonBuilder(manifest);

async function fetchImdbIdsByCatalog(catalogId) {
  const src = SOURCES[catalogId];
  if (!src) return [];

  const cacheKey = `ids:${catalogId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { data } = await axios.get(src.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    },
    timeout: 15000
  });

  const $ = cheerio.load(data);
  const ids = new Set();
  $('a[href^="/title/tt"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/title\/(tt\d+)/);
    if (m) ids.add(m[1]);
  });

  // Popular lists ~100; Top 250 lists ~250
  const limit = catalogId.includes("top250") ? 250 : 100;
  const list = Array.from(ids).slice(0, limit);
  cache.set(cacheKey, list);
  return list.map(id => ({ id, type: src.type }));
}

async function fetchOmdbBatch(items) {
  if (!OMDB_API_KEY) return [];

  // cache per-kind+length to avoid repeat lookups within TTL
  const key = `omdb:${items[0]?.type || "mixed"}:${items.length}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const limit = 10; // concurrency
  const queue = [...items];
  const results = [];

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try {
        const { data } = await axios.get("https://www.omdbapi.com/", {
          params: { i: item.id, apikey: OMDB_API_KEY },
          timeout: 12000
        });
        if (data && data.Response !== "False") {
          results.push({
            id: item.id,
            type: item.type,
            name: data.Title || undefined,
            poster: data.Poster && data.Poster !== "N/A" ? data.Poster : undefined,
            releaseInfo: data.Year || undefined,
            posterShape: "poster"
          });
        } else {
          results.push({ id: item.id, type: item.type, posterShape: "poster" });
        }
      } catch {
        results.push({ id: item.id, type: item.type, posterShape: "poster" });
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  cache.set(key, results);
  return results;
}

builder.defineCatalogHandler(async ({ id }) => {
  try {
    const items = await fetchImdbIdsByCatalog(id); // [{id, type}]
    if (!items.length) return { metas: [] };

    if (OMDB_API_KEY) {
      const metas = await fetchOmdbBatch(items);
      const finalMetas = metas.map((m, i) => ({
        id: m.id,
        type: m.type,
        name: m.name || `IMDb ${m.type === "movie" ? "Movie" : "TV"} #${i + 1}`,
        poster: m.poster,
        releaseInfo: m.releaseInfo,
        posterShape: "poster"
      }));
      return { metas: finalMetas };
    }

    // No OMDb key: placeholders (Cinemeta fills in on clients that can reach it)
    const metas = items.map((it, i) => ({
      id: it.id,
      type: it.type,
      name: `IMDb ${it.type === "movie" ? "Movie" : "TV"} #${i + 1}`,
      posterShape: "poster"
    }));
    return { metas };
  } catch (err) {
    console.error("catalog error", id, err?.message || err);
    return { metas: [] };
  }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log(`IMDb addon running on :${process.env.PORT || 7000}${OMDB_API_KEY ? " (OMDb fallback enabled)" : ""}`);
