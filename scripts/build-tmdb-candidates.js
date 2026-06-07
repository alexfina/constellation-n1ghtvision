#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const https = require("https");

const DATA_DIR = path.join(__dirname, "..", "data");
const OUTPUT_FILE = path.join(DATA_DIR, "candidates.tmdb.json");

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";
const TMDB_API_DISCOVER_PAGE_LIMIT = 500;

const APPROVED_PROVIDERS = [
  "Netflix",
  "Prime Video",
  "Disney+",
  "Paramount+",
  "Crunchyroll"
];

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TARGET_REGION = "AT";
const MIN_RATING = 7.0;

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveDiscoverPageLimit() {
  const configured = parsePositiveInteger(process.env.TMDB_DISCOVER_PAGE_LIMIT);
  if (configured) {
    return Math.min(configured, TMDB_API_DISCOVER_PAGE_LIMIT);
  }
  return TMDB_API_DISCOVER_PAGE_LIMIT;
}

function resolveMaxCandidates() {
  return parsePositiveInteger(process.env.TMDB_MAX_CANDIDATES);
}

function resolveMinVotes(envName, fallback) {
  return parsePositiveInteger(process.env[envName]) || fallback;
}

const DISCOVER_PAGE_LIMIT = resolveDiscoverPageLimit();
const MAX_CANDIDATES = resolveMaxCandidates();
const MIN_MOVIE_VOTES = resolveMinVotes("TMDB_MOVIE_MIN_VOTES", 300);
const MIN_TV_VOTES = resolveMinVotes("TMDB_TV_MIN_VOTES", 100);
const GENRE_SPLIT_ENABLED = String(process.env.TMDB_ENABLE_GENRE_SPLIT || "") === "1";
const SUPPORTED_GENRE_ORDER = [
  "action",
  "action & adventure",
  "adventure",
  "animation",
  "comedy",
  "crime",
  "drama",
  "family",
  "fantasy",
  "history",
  "horror",
  "kids",
  "music",
  "mystery",
  "romance",
  "sci-fi & fantasy",
  "science fiction",
  "thriller",
  "war"
];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function todayIsoDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year + "-" + byType.month + "-" + byType.day;
}

function extractYear(dateString) {
  if (!dateString || typeof dateString !== "string") {
    return null;
  }

  const year = Number.parseInt(dateString.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function noteRejection(stats, reason) {
  if (!stats || !stats.rejectionStats || !Object.prototype.hasOwnProperty.call(stats.rejectionStats, reason)) {
    return;
  }

  stats.rejectionStats[reason] += 1;
}

function extractCandidateGenres(result, genreLookup) {
  if (!Array.isArray(result.genre_ids)) {
    return [];
  }

  const seen = new Set();
  const genres = [];

  result.genre_ids.forEach((id) => {
    const rawGenre = genreLookup.get(id);
    const canonicalGenre = canonicalGenreName(rawGenre);
    if (!canonicalGenre || seen.has(canonicalGenre)) {
      return;
    }

    seen.add(canonicalGenre);
    genres.push(canonicalGenre);
  });

  return genres;
}

function hasJapaneseOrigin(result) {
  if (String(result.original_language || "").toLowerCase() === "ja") {
    return true;
  }

  if (Array.isArray(result.origin_country) && result.origin_country.indexOf("JP") !== -1) {
    return true;
  }

  if (Array.isArray(result.production_countries)) {
    return result.production_countries.some((country) => {
      if (!country) {
        return false;
      }

      if (typeof country === "string") {
        return country === "JP";
      }

      return country.iso_3166_1 === "JP";
    });
  }

  return false;
}

function isAnimeCandidate(result, genreLookup) {
  const genres = extractCandidateGenres(result, genreLookup);
  return genres.indexOf("animation") !== -1 && hasJapaneseOrigin(result);
}

function canonicalProviderName(rawName) {
  const normalized = normalizeText(rawName);

  if (normalized.includes("netflix")) return "Netflix";
  if (normalized.includes("primevideo") || normalized.includes("amazonprime")) return "Prime Video";
  if (normalized.includes("disneyplus") || normalized === "disney") return "Disney+";
  if (normalized.includes("paramountplus") || normalized.includes("paramount")) return "Paramount+";
  if (normalized.includes("crunchyroll")) return "Crunchyroll";

  return null;
}

function canonicalGenreName(rawName) {
  const normalized = normalizeText(rawName);

  if (normalized === "action") return "action";
  if (normalized === "actionadventure") return "action & adventure";
  if (normalized === "adventure") return "adventure";
  if (normalized === "anime") return "anime";
  if (normalized === "animation") return "animation";
  if (normalized === "comedy") return "comedy";
  if (normalized === "crime") return "crime";
  if (normalized === "drama") return "drama";
  if (normalized === "family") return "family";
  if (normalized === "fantasy") return "fantasy";
  if (normalized === "history") return "history";
  if (normalized === "horror") return "horror";
  if (normalized === "kids") return "kids";
  if (normalized === "music") return "music";
  if (normalized === "mystery") return "mystery";
  if (normalized === "romance") return "romance";
  if (normalized === "scififantasy") return "sci-fi & fantasy";
  if (normalized === "sciencefiction") return "science fiction";
  if (normalized === "thriller") return "thriller";
  if (normalized === "war") return "war";

  return null;
}

function buildUrl(endpoint, params) {
  const url = new URL(TMDB_BASE_URL + endpoint);
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function requestJson(url, headers) {
  const requestHeaders = {
    Authorization: "Bearer " + process.env.TMDB_BEARER_TOKEN,
    Accept: "application/json"
  };

  Object.assign(requestHeaders, headers || {});

  if (typeof fetch === "function") {
    const response = await fetch(url, { headers: requestHeaders });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        "TMDB request failed (" +
          response.status +
          " " +
          response.statusText +
          "): " +
          text.slice(0, 200)
      );
    }

    return response.json();
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: requestHeaders }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("TMDB request failed (" + res.statusCode + "): " + body.slice(0, 200)));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error("TMDB response was not valid JSON: " + error.message));
        }
      });
    });

    req.on("error", reject);
  });
}

async function fetchJson(endpoint, params, headers) {
  return requestJson(buildUrl(endpoint, params || {}), headers);
}

async function isFreshEnough(filePath, maxAgeMs) {
  try {
    const stats = await fs.stat(filePath);
    return Date.now() - stats.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

async function resolveApprovedProviders(mediaType) {
  const endpoint = mediaType === "movie" ? "/watch/providers/movie" : "/watch/providers/tv";
  let payload;

  try {
    payload = await fetchJson(endpoint, { watch_region: TARGET_REGION });
  } catch (error) {
    console.warn("[warn] failed to load " + mediaType + " provider list: " + error.message);
    return [];
  }

  const resolved = [];
  (payload.results || []).forEach((provider) => {
    const canonicalName = canonicalProviderName(provider.provider_name);
    if (!canonicalName || APPROVED_PROVIDERS.indexOf(canonicalName) === -1) {
      return;
    }

    resolved.push({
      name: canonicalName,
      id: provider.provider_id
    });
  });

  const byName = new Map();
  resolved.forEach((entry) => {
    if (!byName.has(entry.name)) {
      byName.set(entry.name, entry);
    }
  });

  return APPROVED_PROVIDERS.map((name) => byName.get(name)).filter(Boolean);
}

async function loadGenreLookup(mediaType) {
  const endpoint = mediaType === "movie" ? "/genre/movie/list" : "/genre/tv/list";

  try {
    const payload = await fetchJson(endpoint, { language: "en-US" });
    const lookup = new Map();
    (payload.genres || []).forEach((genre) => {
      if (genre && genre.id && genre.name) {
        lookup.set(genre.id, String(genre.name).toLowerCase());
      }
    });
    return lookup;
  } catch (error) {
    console.warn("[warn] failed to load " + mediaType + " genre list: " + error.message);
    return new Map();
  }
}

function buildGenreDiscoveryFilters(genreLookup) {
  const filters = [];
  const seen = new Set();

  for (const desiredGenre of SUPPORTED_GENRE_ORDER) {
    for (const [id, rawName] of genreLookup.entries()) {
      const canonicalGenre = canonicalGenreName(rawName);
      if (canonicalGenre !== desiredGenre || canonicalGenre === "anime" || seen.has(canonicalGenre)) {
        continue;
      }

      filters.push({
        id: id,
        name: canonicalGenre
      });
      seen.add(canonicalGenre);
      break;
    }
  }

  return filters;
}

function mediaTypeConfig(mediaType) {
  return mediaType === "movie"
    ? { type: "movie", voteThreshold: MIN_MOVIE_VOTES }
    : { type: "series", voteThreshold: MIN_TV_VOTES };
}

function isValidCandidate(result, mediaType, voteThreshold, stats) {
  const validMediaType = mediaType === "movie" || mediaType === "tv";
  const title = String(result && (result.title || result.name) || "").trim();
  const voteAverage = Number(result.vote_average);
  const voteCount = Number(result.vote_count);
  const posterPath = result.poster_path || "";
  const overview = String(result.overview || "").trim();

  if (!validMediaType) {
    noteRejection(stats, "invalidTypeOrMedia");
    return false;
  }

  if (!title) {
    noteRejection(stats, "missingTitle");
    return false;
  }

  if (!Number.isFinite(voteAverage) || voteAverage < MIN_RATING) {
    noteRejection(stats, "ratingBelowMin");
    return false;
  }

  if (!Number.isFinite(voteCount) || voteCount < voteThreshold) {
    return false;
  }

  if (!posterPath) {
    noteRejection(stats, "missingPoster");
    return false;
  }

  if (!overview) {
    noteRejection(stats, "missingOverview");
    return false;
  }

  if (mediaType === "movie") {
    if (!extractYear(result.release_date)) {
      noteRejection(stats, "missingYear");
      return false;
    }
  } else if (!extractYear(result.first_air_date)) {
    noteRejection(stats, "missingYear");
    return false;
  }

  return true;
}

function createCandidateRecord(result, mediaType, platformName, genreLookup, lastChecked) {
  const config = mediaTypeConfig(mediaType);
  const isMovie = mediaType === "movie";
  const title = isMovie ? result.title : result.name;
  const year = isMovie ? extractYear(result.release_date) : extractYear(result.first_air_date);
  const overview = String(result.overview || "").trim();
  const genres = extractCandidateGenres(result, genreLookup);
  if (isAnimeCandidate(result, genreLookup) && genres.indexOf("anime") === -1) {
    genres.unshift("anime");
  }
  const posterPath = String(result.poster_path || "");
  const posterUrl = posterPath ? TMDB_IMAGE_BASE_URL + posterPath : "";

  return {
    id: "tmdb-" + mediaType + "-" + result.id,
    title: String(title || "").trim(),
    type: config.type,
    year: year,
    regions: [TARGET_REGION],
    platforms: [platformName],
    genres: genres,
    moodTags: [],
    qualityTier: "tmdb-candidate",
    rating: Number(result.vote_average),
    voteCount: Number(result.vote_count),
    shortBlurb: overview,
    availabilityStatus: "tmdb-suggested",
    verified: false,
    lastChecked: lastChecked,
    source: "TMDB discover/watch-provider data",
    tmdbId: result.id,
    tmdbMediaType: mediaType,
    posterPath: posterPath,
    posterUrl: posterUrl,
    tmdbOverview: overview
  };
}

function mergePlatforms(existing, platformName) {
  if (existing.platforms.indexOf(platformName) === -1) {
    existing.platforms.push(platformName);
  }
}

function finalizeCandidates(map) {
  const list = Array.from(map.values());

  list.sort((a, b) => {
    if (b.voteCount !== a.voteCount) return b.voteCount - a.voteCount;
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (b.year !== a.year) return b.year - a.year;
    if (a.tmdbMediaType !== b.tmdbMediaType) return a.tmdbMediaType.localeCompare(b.tmdbMediaType);
    return a.tmdbId - b.tmdbId;
  });

  return list;
}

async function discoverCandidatesForMediaType(
  mediaType,
  approvedProviders,
  genreLookup,
  lastChecked,
  candidateMap,
  stats,
  genreFilter
) {
  const minVoteCount = mediaType === "movie" ? MIN_MOVIE_VOTES : MIN_TV_VOTES;
  const endpoint = mediaType === "movie" ? "/discover/movie" : "/discover/tv";

  for (const provider of approvedProviders) {
    if (MAX_CANDIDATES && candidateMap.size >= MAX_CANDIDATES) {
      return;
    }

    for (let page = 1; page <= DISCOVER_PAGE_LIMIT; page += 1) {
      let payload;

      try {
        const params = {
          include_adult: "false",
          watch_region: TARGET_REGION,
          with_watch_region: TARGET_REGION,
          with_watch_monetization_types: "flatrate",
          with_watch_providers: provider.id,
          "vote_average.gte": MIN_RATING,
          "vote_count.gte": minVoteCount,
          sort_by: "vote_count.desc",
          page: page
        };

        if (genreFilter) {
          params.with_genres = genreFilter.id;
        }

        if (stats) {
          if (genreFilter) {
            stats.genreSplitDiscoveryRequests += 1;
          } else {
            stats.baselineDiscoveryRequests += 1;
          }
        }

        payload = await fetchJson(endpoint, params);
      } catch (error) {
        console.warn(
          "[warn] " +
            mediaType +
            " page " +
            page +
            " for " +
            provider.name +
            " failed: " +
            error.message
        );
        break;
      }

      const results = Array.isArray(payload.results) ? payload.results : [];
      if (stats) {
        stats.rawResultsSeen += results.length;
      }
      if (results.length === 0) {
        break;
      }

      for (const result of results) {
        if (stats) {
          const rawKey = mediaType + ":" + String(result && result.id);
          if (!stats.rawTmdbIdSet.has(rawKey)) {
            stats.rawTmdbIdSet.add(rawKey);
            stats.uniqueRawTmdbIdsSeen += 1;
          }
        }

        if (MAX_CANDIDATES && candidateMap.size >= MAX_CANDIDATES) {
          return;
        }

        if (!isValidCandidate(result, mediaType, minVoteCount, stats)) {
          continue;
        }

        const key = mediaType + ":" + result.id;
        const candidate = candidateMap.get(key);

        if (!candidate) {
          candidateMap.set(
            key,
            createCandidateRecord(result, mediaType, provider.name, genreLookup, lastChecked)
          );
        } else {
          if (stats) {
            stats.duplicateCandidatesSkipped += 1;
          }
          mergePlatforms(candidate, provider.name);
        }
      }

      if (payload.total_pages && page >= payload.total_pages) {
        break;
      }

      if (MAX_CANDIDATES && candidateMap.size >= MAX_CANDIDATES) {
        return;
      }
    }
  }
}

async function main() {
  if (!process.env.TMDB_BEARER_TOKEN) {
    throw new Error("Missing TMDB_BEARER_TOKEN environment variable.");
  }

  if (await isFreshEnough(OUTPUT_FILE, CACHE_MAX_AGE_MS)) {
    console.log("candidates.tmdb.json is fresh; skipping refresh: " + OUTPUT_FILE);
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  const lastChecked = todayIsoDate();
  const candidateMap = new Map();
  const discoveryStats = {
    baselineDiscoveryRequests: 0,
    genreSplitDiscoveryRequests: 0,
    rawResultsSeen: 0,
    uniqueRawTmdbIdsSeen: 0,
    rawTmdbIdSet: new Set(),
    duplicateCandidatesSkipped: 0,
    rejectionStats: {
      ratingBelowMin: 0,
      missingOverview: 0,
      missingYear: 0,
      missingPoster: 0,
      missingTitle: 0,
      invalidTypeOrMedia: 0
    }
  };

  const movieProviders = await resolveApprovedProviders("movie");
  const tvProviders = await resolveApprovedProviders("tv");
  const movieGenres = await loadGenreLookup("movie");
  const tvGenres = await loadGenreLookup("tv");
  const movieGenreFilters = buildGenreDiscoveryFilters(movieGenres);
  const tvGenreFilters = buildGenreDiscoveryFilters(tvGenres);

  await discoverCandidatesForMediaType(
    "movie",
    movieProviders,
    movieGenres,
    lastChecked,
    candidateMap,
    discoveryStats,
    null
  );
  await discoverCandidatesForMediaType(
    "tv",
    tvProviders,
    tvGenres,
    lastChecked,
    candidateMap,
    discoveryStats,
    null
  );

  if (GENRE_SPLIT_ENABLED) {
    for (const genreFilter of movieGenreFilters) {
      await discoverCandidatesForMediaType(
        "movie",
        movieProviders,
        movieGenres,
        lastChecked,
        candidateMap,
        discoveryStats,
        genreFilter
      );
    }

    for (const genreFilter of tvGenreFilters) {
      await discoverCandidatesForMediaType(
        "tv",
        tvProviders,
        tvGenres,
        lastChecked,
        candidateMap,
        discoveryStats,
        genreFilter
      );
    }
  }

  const candidates = finalizeCandidates(candidateMap);
  const uniqueCandidatesWritten = candidateMap.size;
  const finalCandidateCount = candidates.length;

  candidates.forEach((candidate) => {
    candidate.platforms = APPROVED_PROVIDERS.filter((name) => candidate.platforms.indexOf(name) !== -1);
  });

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(candidates, null, 2) + "\n", "utf8");

  console.log("TMDB candidate build complete");
  console.log("output file: " + OUTPUT_FILE);
  console.log("baseline discovery requests: " + discoveryStats.baselineDiscoveryRequests);
  console.log("genre-split discovery requests: " + discoveryStats.genreSplitDiscoveryRequests);
  console.log("raw results seen: " + discoveryStats.rawResultsSeen);
  console.log("unique raw TMDB IDs seen: " + discoveryStats.uniqueRawTmdbIdsSeen);
  console.log("duplicates skipped: " + discoveryStats.duplicateCandidatesSkipped);
  console.log("rejections.ratingBelowMin: " + discoveryStats.rejectionStats.ratingBelowMin);
  console.log("rejections.missingOverview: " + discoveryStats.rejectionStats.missingOverview);
  console.log("rejections.missingYear: " + discoveryStats.rejectionStats.missingYear);
  console.log("rejections.missingPoster: " + discoveryStats.rejectionStats.missingPoster);
  console.log("rejections.missingTitle: " + discoveryStats.rejectionStats.missingTitle);
  console.log("rejections.invalidTypeOrMedia: " + discoveryStats.rejectionStats.invalidTypeOrMedia);
  console.log("unique candidates written: " + uniqueCandidatesWritten);
  console.log("final candidate count: " + finalCandidateCount);
  console.log("provider coverage: movie=" + movieProviders.length + ", tv=" + tvProviders.length);
  console.log("movie min votes used: " + MIN_MOVIE_VOTES);
  console.log("tv min votes used: " + MIN_TV_VOTES);
  console.log(
    "discover page limit: " +
      (DISCOVER_PAGE_LIMIT >= TMDB_API_DISCOVER_PAGE_LIMIT
        ? "full mode up to TMDB page cap " + TMDB_API_DISCOVER_PAGE_LIMIT
        : DISCOVER_PAGE_LIMIT)
  );
  console.log("candidate cap: " + (MAX_CANDIDATES ? MAX_CANDIDATES : "none"));
  console.log("genre split enabled: " + (GENRE_SPLIT_ENABLED ? "yes" : "no"));
  console.log("staleness window: 7 days");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
