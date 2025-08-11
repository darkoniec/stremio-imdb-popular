import axios from "axios";
import * as cheerio from "cheerio";
import NodeCache from "node-cache";
import sdk from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = sdk;

const TTL_SECONDS = 60 * 60 * 6; // 6h cache
const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 120 });

const OMDB_API_KEY = process.env.OMDB_API_KEY || "";

const manifest = {
  id: "dev.imdb.popular",
  version: "1.2.0",
  name: "IMDb Popular (Unofficial)",
  description:
    "IMDb 'Most Popular' Movies & TV as Stremio catalogs. Uses Cinemeta; OMDb fallback injects titles/posters.",
  resources: ["catalog"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    { type: "movie", id: "imdb-popular-movies", name: "IMDb Most Popular Movies", extra: [] },
    { type: "series", id: "imdb-popular-series", name: "IMDb Most Popular TV", extra: [] }
  ]
};

const builder = new addonBuilder(manifest);

async function fetchImdbIds(kind) {
  const cacheKey = `ids:${kind}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = kind === "movie"
    ? "https://www.imdb.com/chart/moviemeter/"
    : "https://www.imdb.com/chart/tvmeter/";

  const { data } = await axios.get(url, {
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

  const list = Array.from(ids).slice(0, 100);
  cache.set(cacheKey, list);
  return list;
}

async function fetchOmdbBatch(imdbIds, kind) {
  if (!OMDB_API_KEY) return [];

  const cacheKey = `omdb:${kind}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const limit = 10; // concurrency
  const queue = [...imdbIds];
  const results = [];

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        const { data } = await axios.get("https://www.omdbapi.com/", {
          params: { i: id, apikey: OMDB_API_KEY },
          timeout: 12000
        });
        if (data && data.Response !== "False") {
          results.push({
            id,
            type: kind,
            name: data.Title || undefined,
            poster: data.Poster && data.Poster !== "N/A" ? data.Poster : undefined,
            releaseInfo: data.Year || undefined,
            posterShape: "poster"
          });
        } else {
          results.push({ id, type: kind, posterShape: "poster" });
        }
      } catch {
        results.push({ id, type: kind, posterShape: "poster" });
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  cache.set(cacheKey, results);
  return results;
}

builder.defineCatalogHandler(async ({ type }) => {
  try {
    const ids = await fetchImdbIds(type);

    if (OMDB_API_KEY) {
      const metas = await fetchOmdbBatch(ids, type);
      const finalMetas = metas.map((m, i) => ({
        id: m.id,
        type,
        name: m.name || `IMDb ${type === "movie" ? "Movie" : "TV"} #${i + 1}`,
        poster: m.poster,
        releaseInfo: m.releaseInfo,
        posterShape: "poster"
      }));
      return { metas: finalMetas };
    }

    const metas = ids.map((imdbId, i) => ({
      id: imdbId,
      type,
      name: `IMDb ${type === "movie" ? "Movie" : "TV"} #${i + 1}`,
      posterShape: "poster"
    }));
    return { metas };
  } catch (err) {
    console.error("catalog error", type, err?.message || err);
    return { metas: [] };
  }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log(`IMDb Popular addon running on :${process.env.PORT || 7000}${OMDB_API_KEY ? " (OMDb fallback enabled)" : ""}`);
