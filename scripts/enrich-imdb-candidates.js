#!/usr/bin/env node

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const readline = require("readline");

const SCRIPT_DIR = __dirname;
const DATA_DIR = path.join(SCRIPT_DIR, "..", "data");
const INPUT_FILE = path.join(DATA_DIR, "candidates.tmdb.json");
const OUTPUT_FILE = path.join(DATA_DIR, "candidates.with-imdb.json");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const CACHE_FILE = path.join(CACHE_DIR, "tmdb-external-ids.json");
const IMDB_BASICS_FILE = path.join(DATA_DIR, "imdb", "title.basics.tsv.gz");
const IMDB_RATINGS_FILE = path.join(DATA_DIR, "imdb", "title.ratings.tsv.gz");
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_CONCURRENCY = 5;
const TMDB_MAX_RETRIES = 5;
const SERIES_VISIBLE_GENRE_ORDER = ["History", "Horror", "Music", "Romance", "Thriller"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function parseTsvGenres(value) {
  if (!value || value === "\\N") {
    return [];
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== "\\N");
}

function asFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getHeader(headers, name) {
  if (!headers) {
    return null;
  }

  const key = String(name || "").toLowerCase();
  if (typeof headers.get === "function") {
    return headers.get(key);
  }

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (String(rawKey).toLowerCase() === key) {
      return Array.isArray(rawValue) ? rawValue[0] : rawValue;
    }
  }

  return null;
}

async function requestJson(url, headers) {
  if (typeof fetch === "function") {
    const response = await fetch(url, { headers });
    const text = await response.text();
    let data = null;

    if (text.trim() !== "") {
      data = JSON.parse(text);
    }

    return {
      status: response.status,
      headers: response.headers,
      data
    };
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        let data = null;
        if (body.trim() !== "") {
          try {
            data = JSON.parse(body);
          } catch (error) {
            reject(new Error("TMDB response was not valid JSON: " + error.message));
            return;
          }
        }

        resolve({
          status: response.statusCode || 0,
          headers: response.headers || {},
          data
        });
      });
    });

    req.on("error", reject);
  });
}

function buildExternalIdsUrl(mediaType, tmdbId) {
  const endpoint = mediaType === "movie" ? "/movie/" + tmdbId + "/external_ids" : "/tv/" + tmdbId + "/external_ids";
  return TMDB_BASE_URL + endpoint;
}

async function fetchExternalIds(mediaType, tmdbId, token, stats) {
  const url = buildExternalIdsUrl(mediaType, tmdbId);
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json"
  };

  let attempt = 0;
  while (attempt <= TMDB_MAX_RETRIES) {
    const response = await requestJson(url, headers);

    if (response.status >= 200 && response.status < 300) {
      return response.data || {};
    }

    if (response.status === 404) {
      return {};
    }

    const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (!retryable || attempt === TMDB_MAX_RETRIES) {
      const payload = response && response.data ? JSON.stringify(response.data).slice(0, 200) : "";
      throw new Error(
        "TMDB external_ids request failed (" +
          response.status +
          ") for " +
          mediaType +
          " " +
          tmdbId +
          (payload ? ": " + payload : "")
      );
    }

    const retryAfterHeader = getHeader(response.headers, "retry-after");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const delayMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(1000, retryAfterSeconds * 1000)
      : Math.min(30000, 1000 * Math.pow(2, attempt));

    if (stats && response.status === 429) {
      stats.rateLimitRetries += 1;
    }

    attempt += 1;
    await sleep(delayMs);
  }

  return {};
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];

  function runNext() {
    if (active >= limit || queue.length === 0) {
      return;
    }

    const entry = queue.shift();
    active += 1;

    Promise.resolve()
      .then(entry.task)
      .then(
        (value) => {
          active -= 1;
          entry.resolve(value);
          runNext();
        },
        (error) => {
          active -= 1;
          entry.reject(error);
          runNext();
        }
      );
  }

  return function limitTask(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
  };
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function loadCache(filePath) {
  try {
    return await readJson(filePath);
  } catch {
    return {};
  }
}

async function readImdbTsvGz(filePath, wantedIds, handler) {
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({
      input: stream.pipe(gunzip),
      crlfDelay: Infinity
    });

    let lineNumber = 0;
    rl.on("line", (line) => {
      lineNumber += 1;
      if (lineNumber === 1 || !line) {
        return;
      }

      const parts = line.split("\t");
      const tconst = parts[0];
      if (!wantedIds.has(tconst)) {
        return;
      }

      handler(parts, tconst);
    });

    rl.on("close", resolve);
    rl.on("error", reject);
    stream.on("error", reject);
    gunzip.on("error", reject);
  });
}

function buildCandidateKey(candidate) {
  return String(candidate.tmdbMediaType || candidate.type || "") + ":" + String(candidate.tmdbId || "");
}

function buildImdbUrl(imdbId) {
  return imdbId ? "https://www.imdb.com/title/" + imdbId + "/" : null;
}

function buildEnrichedCandidate(candidate, imdbRecord) {
  const imdbId = candidate.imdbId || null;
  const imdbRating = imdbRecord && imdbRecord.rating !== undefined ? imdbRecord.rating : null;
  const imdbVotes = imdbRecord && imdbRecord.votes !== undefined ? imdbRecord.votes : null;
  const imdbGenres = imdbRecord && Array.isArray(imdbRecord.genres) ? imdbRecord.genres : [];
  const genres = Array.isArray(candidate.genres) ? candidate.genres.slice() : [];
  const imdbAddedGenres = [];

  if (candidate.type === "series" && imdbGenres.length > 0) {
    SERIES_VISIBLE_GENRE_ORDER.forEach((genre) => {
      if (
        imdbGenres.some((imdbGenre) => normalizeText(imdbGenre) === normalizeText(genre)) &&
        !genres.some((existingGenre) => normalizeText(existingGenre) === normalizeText(genre))
      ) {
        genres.push(genre);
        imdbAddedGenres.push(genre);
      }
    });
  }

  return {
    ...candidate,
    genres: genres,
    imdbId: imdbId,
    imdbRating: imdbRating,
    imdbVotes: imdbVotes,
    imdbGenres: imdbGenres,
    imdbAddedGenres: imdbAddedGenres,
    imdbUrl: buildImdbUrl(imdbId)
  };
}

async function main() {
  const token = process.env.TMDB_BEARER_TOKEN;
  if (!token) {
    throw new Error("Missing TMDB_BEARER_TOKEN environment variable.");
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });

  const [candidates, cache] = await Promise.all([
    readJson(INPUT_FILE),
    loadCache(CACHE_FILE)
  ]);

  if (!Array.isArray(candidates)) {
    throw new Error("Input file must contain a JSON array: " + INPUT_FILE);
  }

  const cacheStore = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
  const limit = createLimiter(TMDB_CONCURRENCY);
  const fetchStats = {
    cacheHits: 0,
    cacheMisses: 0,
    reusedExistingImdbId: 0,
    missingTmdbIdentity: 0,
    rateLimitRetries: 0,
    errors: []
  };

  const enriched = candidates.map((candidate) => ({ ...candidate }));
  const imdbIdByCandidateId = new Map();

  const fetchTasks = enriched.map((candidate) =>
    limit(async () => {
      const existingImdbId = candidate.imdbId && String(candidate.imdbId).trim() !== "" ? String(candidate.imdbId).trim() : null;
      if (existingImdbId) {
        fetchStats.reusedExistingImdbId += 1;
        imdbIdByCandidateId.set(candidate.id, existingImdbId);
        return;
      }

      if (!candidate.tmdbId || !candidate.tmdbMediaType) {
        fetchStats.missingTmdbIdentity += 1;
        imdbIdByCandidateId.set(candidate.id, null);
        return;
      }

      const cacheKey = buildCandidateKey(candidate);
      if (Object.prototype.hasOwnProperty.call(cacheStore, cacheKey)) {
        fetchStats.cacheHits += 1;
        const cached = cacheStore[cacheKey];
        const cachedImdbId =
          cached && typeof cached === "object"
            ? String(cached.imdb_id || cached.imdbId || "").trim() || null
            : null;
        imdbIdByCandidateId.set(candidate.id, cachedImdbId);
        return;
      }

      fetchStats.cacheMisses += 1;
      try {
        const externalIds = await fetchExternalIds(candidate.tmdbMediaType, candidate.tmdbId, token, fetchStats);
        cacheStore[cacheKey] = externalIds || {};
        const fetchedImdbId =
          externalIds && (externalIds.imdb_id || externalIds.imdbId)
            ? String(externalIds.imdb_id || externalIds.imdbId).trim() || null
            : null;
        imdbIdByCandidateId.set(candidate.id, fetchedImdbId);
      } catch (error) {
        fetchStats.errors.push({
          candidateId: candidate.id,
          tmdbId: candidate.tmdbId,
          mediaType: candidate.tmdbMediaType,
          message: error.message
        });
        imdbIdByCandidateId.set(candidate.id, null);
      }
    })
  );

  await Promise.all(fetchTasks);
  await writeJson(CACHE_FILE, cacheStore);

  const wantedImdbIds = new Set();
  enriched.forEach((candidate) => {
    const imdbId = imdbIdByCandidateId.get(candidate.id) || (candidate.imdbId && String(candidate.imdbId).trim() !== "" ? String(candidate.imdbId).trim() : null);
    if (imdbId) {
      wantedImdbIds.add(imdbId);
    }
  });

  const ratingsById = new Map();
  const genresById = new Map();

  if (wantedImdbIds.size > 0) {
    await readImdbTsvGz(IMDB_BASICS_FILE, wantedImdbIds, (parts, tconst) => {
      const imdbGenres = parseTsvGenres(parts[8]);
      genresById.set(tconst, imdbGenres);
    });

    await readImdbTsvGz(IMDB_RATINGS_FILE, wantedImdbIds, (parts, tconst) => {
      ratingsById.set(tconst, {
        rating: asFiniteNumber(parts[1]),
        votes: asFiniteNumber(parts[2])
      });
    });
  }

  const output = enriched.map((candidate) => {
    const imdbId = imdbIdByCandidateId.get(candidate.id) || (candidate.imdbId && String(candidate.imdbId).trim() !== "" ? String(candidate.imdbId).trim() : null);
    const imdbRecord = imdbId
      ? {
          rating: ratingsById.has(imdbId) ? ratingsById.get(imdbId).rating : null,
          votes: ratingsById.has(imdbId) ? ratingsById.get(imdbId).votes : null,
          genres: genresById.has(imdbId) ? genresById.get(imdbId) : []
        }
      : {
          rating: null,
          votes: null,
          genres: []
        };

    return buildEnrichedCandidate(
      {
        ...candidate,
        imdbId: imdbId
      },
      imdbRecord
    );
  });

  await writeJson(OUTPUT_FILE, output);

  const totals = {
    totalCandidates: output.length,
    candidatesWithImdbId: 0,
    candidatesWithImdbRating: 0,
    candidatesWithImdbGenres: 0,
    missingImdbId: 0,
    missingImdbRating: 0,
    seriesThrillerGenreMismatch: 0,
    seriesImdbGenreAdds: {
      History: 0,
      Horror: 0,
      Music: 0,
      Romance: 0,
      Thriller: 0
    }
  };

  const successfulMatches = [];
  const missingMatches = [];

  output.forEach((candidate) => {
    const hasImdbId = Boolean(candidate.imdbId);
    const hasImdbRating = Number.isFinite(candidate.imdbRating);
    const hasImdbGenres = Array.isArray(candidate.imdbGenres) && candidate.imdbGenres.length > 0;

    if (hasImdbId) {
      totals.candidatesWithImdbId += 1;
    } else {
      totals.missingImdbId += 1;
    }

    if (hasImdbRating) {
      totals.candidatesWithImdbRating += 1;
    } else {
      totals.missingImdbRating += 1;
    }

    if (hasImdbGenres) {
      totals.candidatesWithImdbGenres += 1;
    }

    if (hasImdbId && hasImdbRating && hasImdbGenres && successfulMatches.length < 5) {
      successfulMatches.push({
        id: candidate.id,
        title: candidate.title,
        type: candidate.type,
        imdbId: candidate.imdbId,
        imdbRating: candidate.imdbRating,
        imdbGenres: candidate.imdbGenres
      });
    }

    if (!hasImdbId && missingMatches.length < 5) {
      missingMatches.push({
        id: candidate.id,
        title: candidate.title,
        type: candidate.type,
        tmdbId: candidate.tmdbId || null
      });
    }

    if (
      candidate.type === "series" &&
      Array.isArray(candidate.imdbGenres) &&
      candidate.imdbGenres.some((genre) => normalizeText(genre) === "thriller") &&
      !(Array.isArray(candidate.genres) && candidate.genres.some((genre) => normalizeText(genre) === "thriller"))
    ) {
      totals.seriesThrillerGenreMismatch += 1;
    }

    if (candidate.type === "series" && Array.isArray(candidate.imdbAddedGenres)) {
      candidate.imdbAddedGenres.forEach((genre) => {
        if (Object.prototype.hasOwnProperty.call(totals.seriesImdbGenreAdds, genre)) {
          totals.seriesImdbGenreAdds[genre] += 1;
        }
      });
    }
  });

  console.log("IMDb enrichment complete");
  console.log("input file: " + INPUT_FILE);
  console.log("output file: " + OUTPUT_FILE);
  console.log("cache file: " + CACHE_FILE);
  console.log("total candidates: " + totals.totalCandidates);
  console.log("candidates with imdbId: " + totals.candidatesWithImdbId);
  console.log("candidates with imdbRating: " + totals.candidatesWithImdbRating);
  console.log("candidates with imdbGenres: " + totals.candidatesWithImdbGenres);
  console.log("missing imdbId count: " + totals.missingImdbId);
  console.log("missing imdbRating count: " + totals.missingImdbRating);
  console.log("series with imdbGenres Thriller but normalized genres missing Thriller: " + totals.seriesThrillerGenreMismatch);
  console.log("series imdb genre adds by visible genre: " + JSON.stringify(totals.seriesImdbGenreAdds));
  console.log("TMDB external_id cache hits: " + fetchStats.cacheHits);
  console.log("TMDB external_id cache misses: " + fetchStats.cacheMisses);
  console.log("existing imdbId reused: " + fetchStats.reusedExistingImdbId);
  console.log("missing TMDB identity skipped: " + fetchStats.missingTmdbIdentity);
  console.log("rate-limit retries: " + fetchStats.rateLimitRetries);
  console.log("successful match examples: " + JSON.stringify(successfulMatches, null, 2));
  console.log("missing match examples: " + JSON.stringify(missingMatches, null, 2));
  if (fetchStats.errors.length > 0) {
    console.log("errors: " + JSON.stringify(fetchStats.errors.slice(0, 20), null, 2));
  } else {
    console.log("errors: []");
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
