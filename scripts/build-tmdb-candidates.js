#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const https = require("https");

const DATA_DIR = path.join(__dirname, "..", "data");
const OUTPUT_FILE = path.join(DATA_DIR, "candidates.tmdb.json");

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";
const TMDB_API_DISCOVER_PAGE_LIMIT = 500;

const TARGET_REGIONS = ["AT", "US"];

const APPROVED_PROVIDERS = [
  "Netflix",
  "Prime Video",
  "Disney+",
  "Apple TV+",
  "Paramount+",
  "Crunchyroll",
  "Max",
  "Hulu",
  "Peacock"
];

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_RATING = 7.0;
const VISIBLE_GENRE_ORDER = [
  "Action",
  "Adventure",
  "Comedy",
  "Crime",
  "Drama",
  "Family",
  "Fantasy",
  "History",
  "Horror",
  "Music",
  "Mystery",
  "Romance",
  "Sci-Fi",
  "Thriller",
  "War",
  "Western"
];
const DISCOVERY_RAW_GENRE_ORDER = [
  "Action",
  "Action & Adventure",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "History",
  "Horror",
  "Kids",
  "Music",
  "Mystery",
  "Romance",
  "Science Fiction",
  "Sci-Fi & Fantasy",
  "Thriller",
  "War",
  "War & Politics",
  "Western",
  "News",
  "Reality",
  "Soap",
  "Talk",
  "TV Movie"
];

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

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function addUnique(list, value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return list;
  }

  const text = String(value);
  if (list.indexOf(text) === -1) {
    list.push(text);
  }

  return list;
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

function extractRawGenres(result, genreLookup) {
  if (!Array.isArray(result.genre_ids)) {
    return [];
  }

  const seen = new Set();
  const rawGenres = [];

  result.genre_ids.forEach((id) => {
    const rawGenre = genreLookup.get(id);
    const key = normalizeText(rawGenre);
    if (!rawGenre || seen.has(key)) {
      return;
    }

    seen.add(key);
    rawGenres.push(String(rawGenre));
  });

  return rawGenres;
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

function isAnimeCandidate(result, rawGenres) {
  return rawGenres.some((genre) => normalizeText(genre) === "animation") && hasJapaneseOrigin(result);
}

function canonicalProviderName(rawName) {
  const normalized = normalizeText(rawName);

  if (normalized.includes("netflix")) return "Netflix";
  if (normalized.includes("primevideo") || normalized.includes("amazonprime")) return "Prime Video";
  if (normalized.includes("disneyplus") || normalized === "disney") return "Disney+";
  if (normalized.includes("paramountplus") || normalized.includes("paramount")) return "Paramount+";
  if (normalized.includes("appletv")) return "Apple TV+";
  if (normalized.includes("hbomax") || normalized === "max") return "Max";
  if (normalized.includes("hulu")) return "Hulu";
  if (normalized.includes("peacock")) return "Peacock";
  if (normalized.includes("crunchyroll")) return "Crunchyroll";

  return null;
}

function normalizeCandidateGenres(rawGenres) {
  const normalized = [];

  function pushGenre(value) {
    addUnique(normalized, value);
  }

  rawGenres.forEach((genre) => {
    const key = normalizeText(genre);

    if (key === "action") {
      pushGenre("Action");
      return;
    }

    if (key === "actionadventure") {
      pushGenre("Action");
      pushGenre("Adventure");
      return;
    }

    if (key === "adventure") {
      pushGenre("Adventure");
      return;
    }

    if (key === "comedy") {
      pushGenre("Comedy");
      return;
    }

    if (key === "crime") {
      pushGenre("Crime");
      return;
    }

    if (key === "drama") {
      pushGenre("Drama");
      return;
    }

    if (key === "family" || key === "kids") {
      pushGenre("Family");
      return;
    }

    if (key === "fantasy") {
      pushGenre("Fantasy");
      return;
    }

    if (key === "history") {
      pushGenre("History");
      return;
    }

    if (key === "horror") {
      pushGenre("Horror");
      return;
    }

    if (key === "music") {
      pushGenre("Music");
      return;
    }

    if (key === "mystery") {
      pushGenre("Mystery");
      return;
    }

    if (key === "romance") {
      pushGenre("Romance");
      return;
    }

    if (key === "sciencefiction") {
      pushGenre("Sci-Fi");
      return;
    }

    if (key === "scififantasy") {
      pushGenre("Sci-Fi");
      pushGenre("Fantasy");
      return;
    }

    if (key === "thriller") {
      pushGenre("Thriller");
      return;
    }

    if (key === "war" || key === "warpolitics") {
      pushGenre("War");
      return;
    }

    if (key === "western") {
      pushGenre("Western");
    }
  });

  return normalized;
}

function deriveFormatStyle(rawGenres, result) {
  const hasDocumentary = rawGenres.some((genre) => normalizeText(genre) === "documentary");
  if (hasDocumentary) {
    return "Documentary";
  }

  if (isAnimeCandidate(result, rawGenres)) {
    return "Anime";
  }

  return "Live Action";
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

async function resolveApprovedProviders(mediaType, watchRegion) {
  const endpoint = mediaType === "movie" ? "/watch/providers/movie" : "/watch/providers/tv";
  let payload;

  try {
    payload = await fetchJson(endpoint, { watch_region: watchRegion });
  } catch (error) {
    console.warn("[warn] failed to load " + mediaType + " provider list for " + watchRegion + ": " + error.message);
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
        lookup.set(genre.id, String(genre.name));
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

  for (const desiredRawName of DISCOVERY_RAW_GENRE_ORDER) {
    const desiredKey = normalizeText(desiredRawName);
    for (const [id, rawName] of genreLookup.entries()) {
      if (normalizeText(rawName) !== desiredKey || seen.has(id)) {
        continue;
      }

      filters.push({
        id: id,
        name: String(rawName)
      });
      seen.add(id);
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

function createCandidateRecord(result, mediaType, platformName, rawGenres, lastChecked, region) {
  const config = mediaTypeConfig(mediaType);
  const isMovie = mediaType === "movie";
  const title = isMovie ? result.title : result.name;
  const year = isMovie ? extractYear(result.release_date) : extractYear(result.first_air_date);
  const overview = String(result.overview || "").trim();
  const formatStyle = deriveFormatStyle(rawGenres, result);
  const genres = normalizeCandidateGenres(rawGenres);
  const posterPath = String(result.poster_path || "");
  const posterUrl = posterPath ? TMDB_IMAGE_BASE_URL + posterPath : "";

  return {
    id: "tmdb-" + mediaType + "-" + result.id,
    title: String(title || "").trim(),
    type: config.type,
    year: year,
    regions: [region],
    platforms: [platformName],
    availability: [{ region: region, platform: platformName }],
    rawGenres: rawGenres.slice(),
    genres: genres,
    formatStyle: formatStyle,
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

function addAvailabilityPair(existing, region, platformName) {
  if (!existing.availability) {
    existing.availability = [];
  }

  const pairExists = existing.availability.some((entry) => entry.region === region && entry.platform === platformName);
  if (!pairExists) {
    existing.availability.push({ region: region, platform: platformName });
  }
}

function availabilitySortValue(values, orderedValues, fallbackValue) {
  const index = orderedValues.indexOf(values);
  return index === -1 ? fallbackValue : index;
}

function sortAvailabilityPairs(availability) {
  return availability.slice().sort((left, right) => {
    const leftRegionIndex = availabilitySortValue(left.region, TARGET_REGIONS, TARGET_REGIONS.length);
    const rightRegionIndex = availabilitySortValue(right.region, TARGET_REGIONS, TARGET_REGIONS.length);
    if (leftRegionIndex !== rightRegionIndex) {
      return leftRegionIndex - rightRegionIndex;
    }

    if (left.region !== right.region) {
      return String(left.region || "").localeCompare(String(right.region || ""));
    }

    const leftPlatformIndex = availabilitySortValue(left.platform, APPROVED_PROVIDERS, APPROVED_PROVIDERS.length);
    const rightPlatformIndex = availabilitySortValue(right.platform, APPROVED_PROVIDERS, APPROVED_PROVIDERS.length);
    if (leftPlatformIndex !== rightPlatformIndex) {
      return leftPlatformIndex - rightPlatformIndex;
    }

    return String(left.platform || "").localeCompare(String(right.platform || ""));
  });
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

  list.forEach((candidate) => {
    const availability = Array.isArray(candidate.availability) ? candidate.availability : [];
    candidate.availability = sortAvailabilityPairs(
      availability.filter(
        (entry) =>
          entry &&
          TARGET_REGIONS.indexOf(entry.region) !== -1 &&
          APPROVED_PROVIDERS.indexOf(entry.platform) !== -1
      )
    );
    candidate.regions = TARGET_REGIONS.filter((region) =>
      candidate.availability.some((entry) => entry.region === region)
    );
    candidate.platforms = APPROVED_PROVIDERS.filter((name) =>
      candidate.availability.some((entry) => entry.platform === name)
    );
    candidate.rawGenres = Array.isArray(candidate.rawGenres)
      ? candidate.rawGenres.filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
      : [];
    candidate.genres = VISIBLE_GENRE_ORDER.filter((name) => candidate.genres.indexOf(name) !== -1);
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
  genreFilter,
  watchRegion
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
          watch_region: watchRegion,
          with_watch_region: watchRegion,
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
        const rawGenres = extractRawGenres(result, genreLookup);
        const candidate = candidateMap.get(key);

        if (!candidate) {
          candidateMap.set(
            key,
            createCandidateRecord(result, mediaType, provider.name, rawGenres, lastChecked, watchRegion)
          );
        } else {
          if (stats) {
            stats.duplicateCandidatesSkipped += 1;
          }
          addAvailabilityPair(candidate, watchRegion, provider.name);
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

  const regionProviderPairs = [];
  const movieGenres = await loadGenreLookup("movie");
  const tvGenres = await loadGenreLookup("tv");
  const movieGenreFilters = buildGenreDiscoveryFilters(movieGenres);
  const tvGenreFilters = buildGenreDiscoveryFilters(tvGenres);

  for (const region of TARGET_REGIONS) {
    const movieProviders = await resolveApprovedProviders("movie", region);
    const tvProviders = await resolveApprovedProviders("tv", region);
    regionProviderPairs.push({ region, movieProviders, tvProviders });

    await discoverCandidatesForMediaType(
      "movie",
      movieProviders,
      movieGenres,
      lastChecked,
      candidateMap,
      discoveryStats,
      null,
      region
    );
    await discoverCandidatesForMediaType(
      "tv",
      tvProviders,
      tvGenres,
      lastChecked,
      candidateMap,
      discoveryStats,
      null,
      region
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
          genreFilter,
          region
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
          genreFilter,
          region
        );
      }
    }
  }

  const candidates = finalizeCandidates(candidateMap);
  const uniqueCandidatesWritten = candidateMap.size;
  const finalCandidateCount = candidates.length;

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(candidates, null, 2) + "\n", "utf8");

  const regionCounts = countBy(candidates, (candidate) => candidate.regions);
  const platformCounts = countBy(candidates, (candidate) => candidate.platforms);
  const typeCounts = countBy(candidates, (candidate) => [candidate.type]);
  const formatStyleCounts = countBy(candidates, (candidate) => [candidate.formatStyle]);
  const genreCounts = countBy(candidates, (candidate) => candidate.genres);
  const emptyGenreCount = candidates.filter((candidate) => !Array.isArray(candidate.genres) || candidate.genres.length === 0).length;
  const animeExamples = candidates.filter((candidate) => candidate.formatStyle === "Anime").slice(0, 5);
  const documentaryExamples = candidates.filter((candidate) => candidate.formatStyle === "Documentary").slice(0, 5);
  const westernExamples = candidates.filter((candidate) => Array.isArray(candidate.genres) && candidate.genres.indexOf("Western") !== -1).slice(0, 5);
  const missingVisibleGenres = VISIBLE_GENRE_ORDER.filter((genre) => !genreCounts[genre]);

  console.log("TMDB candidate build complete");
  console.log("output file: " + OUTPUT_FILE);
  console.log("total candidates: " + finalCandidateCount);
  console.log("movie count: " + typeCounts.movie);
  console.log("series count: " + typeCounts.series);
  console.log("count by region: " + JSON.stringify(regionCounts));
  console.log("count by platform: " + JSON.stringify(platformCounts));
  console.log("count by type: " + JSON.stringify(typeCounts));
  console.log("count by formatStyle: " + JSON.stringify(formatStyleCounts));
  console.log("count by normalized genre: " + JSON.stringify(genreCounts));
  console.log("empty genre count: " + emptyGenreCount);
  console.log("anime examples: " + JSON.stringify(animeExamples.slice(0, 3).map((candidate) => candidate.title)));
  console.log("documentary examples: " + JSON.stringify(documentaryExamples.slice(0, 3).map((candidate) => candidate.title)));
  console.log("western examples: " + JSON.stringify(westernExamples.slice(0, 3).map((candidate) => candidate.title)));
  if (missingVisibleGenres.length > 0) {
    console.warn("warning: visible genres with zero candidates: " + missingVisibleGenres.join(", "));
  }
  if (!regionCounts.US) {
    console.warn("warning: United States currently has zero candidates");
  }
  if (!regionCounts.AT) {
    console.warn("warning: Austria currently has zero candidates");
  }
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
  console.log(
    "provider coverage: " +
      regionProviderPairs.map((entry) => entry.region + "(movie=" + entry.movieProviders.length + ", tv=" + entry.tvProviders.length + ")").join(", ")
  );
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

function countBy(items, selector) {
  const counts = {};
  items.forEach((item) => {
    const values = Array.isArray(selector(item)) ? selector(item) : [];
    values.forEach((value) => {
      const key = String(value);
      if (!key) {
        return;
      }
      counts[key] = (counts[key] || 0) + 1;
    });
  });
  return counts;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
