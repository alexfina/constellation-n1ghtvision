#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const SCRIPT_DIR = __dirname;
const DATA_DIR = path.join(SCRIPT_DIR, "..", "data");
const INPUT_FILE = path.join(DATA_DIR, "recommendations.json");
const OUTPUT_FILE = path.join(DATA_DIR, "recommendations.enriched.json");
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = new Array(b.length + 1);
  const current = new Array(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function similarityScore(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);

  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  if (left.includes(right) || right.includes(left)) {
    return 0.92;
  }

  const distance = levenshteinDistance(left, right);
  const longest = Math.max(left.length, right.length);
  return Math.max(0, 1 - distance / longest);
}

function extractYearFromDate(dateString) {
  if (!dateString || typeof dateString !== "string") {
    return null;
  }
  const year = Number.parseInt(dateString.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function getResultTitle(result) {
  return result.title || result.name || result.original_title || result.original_name || "";
}

function getResultYear(result, mediaType) {
  if (mediaType === "movie") {
    return extractYearFromDate(result.release_date);
  }
  return extractYearFromDate(result.first_air_date);
}

function yearScore(inputYear, resultYear) {
  if (!Number.isFinite(inputYear) || !Number.isFinite(resultYear)) {
    return 0.55;
  }

  const delta = Math.abs(inputYear - resultYear);
  if (delta === 0) return 1;
  if (delta === 1) return 0.88;
  if (delta === 2) return 0.72;
  if (delta === 3) return 0.55;
  if (delta <= 5) return 0.35;
  return 0;
}

function scoreCandidate(item, candidate) {
  const titleScore = similarityScore(item.title, getResultTitle(candidate));
  const itemYear = Number.isFinite(item.year) ? item.year : null;
  const resultYear = getResultYear(candidate, candidate.media_type);
  const dateScore = yearScore(itemYear, resultYear);

  const combined = titleScore * 0.78 + dateScore * 0.22;
  return {
    combined,
    titleScore,
    dateScore,
    resultYear
  };
}

function isConfidentMatch(score) {
  return score.combined >= 0.82 && score.titleScore >= 0.75;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  const body = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(filePath, body, "utf8");
}

async function tmdbFetch(token, endpoint) {
  const url = TMDB_BASE_URL + endpoint;
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json"
  };

  if (typeof fetch === "function") {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const text = await response.text().catch(function () {
        return "";
      });
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

  const https = require("https");
  return new Promise(function (resolve, reject) {
    const request = https.get(url, { headers }, function (response) {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", function (chunk) {
        body += chunk;
      });
      response.on("end", function () {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(
            new Error(
              "TMDB request failed (" +
                response.statusCode +
                "): " +
                body.slice(0, 200)
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error("TMDB response was not valid JSON: " + error.message));
        }
      });
    });

    request.on("error", reject);
  });
}

async function searchTmdbCandidates(token, item, mediaType) {
  const yearQuery =
    Number.isFinite(item.year) && item.year > 0
      ? mediaType === "movie"
        ? "&year=" + encodeURIComponent(item.year)
        : "&first_air_date_year=" + encodeURIComponent(item.year)
      : "";

  const queries = [
    "/search/" +
      mediaType +
      "?query=" +
      encodeURIComponent(item.title) +
      "&include_adult=false&language=en-US&page=1" +
      yearQuery,
    "/search/" +
      mediaType +
      "?query=" +
      encodeURIComponent(item.title) +
      "&include_adult=false&language=en-US&page=1"
  ];

  const seen = new Set();
  const results = [];

  for (const endpoint of queries) {
    const payload = await tmdbFetch(token, endpoint);
    for (const result of payload.results || []) {
      const key = String(result.id) + ":" + (result.media_type || mediaType);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({
        ...result,
        media_type: result.media_type || mediaType
      });
    }
  }

  return results;
}

function buildEnrichedItem(item, match) {
  if (!match) {
    return {
      ...item,
      tmdbMatchStatus: "not matched"
    };
  }

  const posterPath = match.poster_path || null;
  return {
    ...item,
    tmdbId: match.id,
    tmdbMediaType: match.media_type,
    posterPath: posterPath,
    posterUrl: posterPath ? TMDB_IMAGE_BASE_URL + posterPath : null,
    tmdbOverview: match.overview || null,
    tmdbMatchStatus: "matched"
  };
}

async function main() {
  const token = process.env.TMDB_BEARER_TOKEN;
  if (!token) {
    throw new Error("Missing TMDB_BEARER_TOKEN environment variable.");
  }

  const recommendations = await readJson(INPUT_FILE);
  if (!Array.isArray(recommendations)) {
    throw new Error("Input file must contain a JSON array.");
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  const enriched = [];
  let matchedCount = 0;
  let notMatchedCount = 0;
  let skippedCount = 0;

  for (const item of recommendations) {
    try {
      const mediaType = item.type === "movie" ? "movie" : "tv";
      const candidates = await searchTmdbCandidates(token, item, mediaType);

      let bestMatch = null;
      let bestScore = null;

      for (const candidate of candidates) {
        const score = scoreCandidate(item, candidate);
        if (!bestScore || score.combined > bestScore.combined) {
          bestMatch = candidate;
          bestScore = score;
        }
      }

      if (bestMatch && bestScore && isConfidentMatch(bestScore)) {
        enriched.push(buildEnrichedItem(item, bestMatch));
        matchedCount += 1;
        console.log(
          "[matched] " +
            item.title +
            " -> TMDB " +
            bestMatch.media_type +
            " " +
            bestMatch.id +
            " (score " +
            bestScore.combined.toFixed(2) +
            ", year " +
            (bestScore.resultYear == null ? "n/a" : bestScore.resultYear) +
            ")"
        );
      } else {
        enriched.push(buildEnrichedItem(item, null));
        notMatchedCount += 1;
        console.log("[not matched] " + item.title);
      }
    } catch (error) {
      skippedCount += 1;
      enriched.push(buildEnrichedItem(item, null));
      console.warn("[skipped] " + item.title + ": " + error.message);
    }
  }

  await writeJson(OUTPUT_FILE, enriched);

  console.log("");
  console.log("TMDB enrichment summary");
  console.log("total items processed: " + recommendations.length);
  console.log("matched count: " + matchedCount);
  console.log("not matched count: " + notMatchedCount);
  console.log("uncertain/skipped count: " + skippedCount);
  console.log("output written to: " + OUTPUT_FILE);
}

main().catch(function (error) {
  console.error(error.message);
  process.exitCode = 1;
});
