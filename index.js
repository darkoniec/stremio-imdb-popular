import axios from "axios";
import * as cheerio from "cheerio";
import NodeCache from "node-cache";
import sdk from "stremio-addon-sdk";

const { addonBuilder, serveHTTP } = sdk;

const TTL_SECONDS = 60 * 60 * 6; // cache IMDb results for 6 hours
const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 120 });

const manifest = {
  id: "dev.imdb.popular",
  version: "1.0.0",
  name: "IMDb Popular (Unofficial)",
  description:
    "Shows IMDb \"Most Popular\" Movies & TV as Stremio catalogs. Uses IMDb charts pages (see README for terms).",
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

builder.defineCatalogHandler(async ({ type }) => {
  try {
    const ids = await fetchImdbIds(type);
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
console.log(`IMDb Popular addon running on :${process.env.PORT || 7000}`);
