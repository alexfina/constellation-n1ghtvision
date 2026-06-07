const DATA_URL = "data/candidates.tmdb.json";

const regionSelect = document.getElementById("region-select");
const platformSelect = document.getElementById("platform-select");
const typeSelect = document.getElementById("type-select");
const genreSelect = document.getElementById("genre-select");
const ratingSelect = document.getElementById("rating-select");
const revealButton = document.getElementById("reveal-button");
const resultsGrid = document.getElementById("results-grid");
const showMoreButton = document.getElementById("show-more-button");
const statusEl = document.getElementById("status");
const resultContextEl = document.getElementById("result-context");
const eyebrowEl = document.querySelector(".eyebrow");

const VERSION_LABEL = "N1GHTVISION V1.0";
const TMDB_ATTRIBUTION =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";

let tmdbAttributionEl = null;

let recommendations = [];
let revealedOnce = false;
let activeResults = [];
let visibleResultCount = 0;
const INITIAL_RESULT_COUNT = 12;
const SHOW_MORE_INCREMENT = 12;

init().catch((error) => {
  console.error(error);
  showEmptyState(
    "Could not load the recommendations file.",
    "Check that the page is being served from a local web server."
  );
});

async function init() {
  if (eyebrowEl) {
    eyebrowEl.textContent = VERSION_LABEL;
  }

  ensureTmdbAttribution();
  setStatus("Loading recommendations...");
  const data = await loadRecommendations();
  recommendations = Array.isArray(data) ? data : data.recommendations ?? [];

  populateSelect(regionSelect, collectValues(recommendations, ["regions", "region"]));
  populateSelect(platformSelect, collectValues(recommendations, ["platforms", "platform"]));
  populateSelect(genreSelect, collectValues(recommendations, ["genres", "genre"]));
  if (ratingSelect) {
    ratingSelect.innerHTML = [
      '<option value="">All Ratings</option>',
      '<option value="7">7.0+</option>',
      '<option value="8">8.0+</option>',
      '<option value="9">9.0+</option>',
    ].join("");
  }

  setStatus("Choose filters, then reveal matching TMDB candidates.");
  setRevealButtonState(false);
  clearResults();
  setShowMoreState(false, 0, 0);

  [regionSelect, platformSelect, typeSelect, genreSelect, ratingSelect].filter(Boolean).forEach((select) => {
    select.addEventListener("change", () => {
      if (revealedOnce) {
        renderRecommendations();
      } else {
        clearResults();
      }
    });
  });

  revealButton.addEventListener("click", () => {
    revealedOnce = true;
    setRevealButtonState(true);
    renderRecommendations();
  });

  if (showMoreButton) {
    showMoreButton.addEventListener("click", () => {
      if (visibleResultCount >= activeResults.length) {
        setShowMoreState(false, visibleResultCount, activeResults.length);
        return;
      }

      visibleResultCount = Math.min(visibleResultCount + SHOW_MORE_INCREMENT, activeResults.length);
      renderVisibleResults();
    });
  }
}

async function loadRecommendations() {
  const response = await fetch(DATA_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load " + DATA_URL + ": " + response.status);
  }
  return response.json();
}

function populateSelect(select, values) {
  const options = ["", ...values].filter(Boolean);
  const label = select.name.charAt(0).toUpperCase() + select.name.slice(1);
  select.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "All " + label + "s";
  select.appendChild(defaultOption);

  options.forEach((value) => {
    if (!value) {
      return;
    }
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function collectValues(items, keys) {
  const values = new Set();

  items.forEach((item) => {
    keys.forEach((key) => {
      asArray(item && item[key]).forEach((value) => values.add(String(value)));
    });
  });

  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function renderRecommendations() {
  const selectedRegion = regionSelect.value;
  const selectedPlatform = platformSelect.value;
  const selectedType = typeSelect ? typeSelect.value : "";
  const selectedGenre = genreSelect.value;
  const selectedRating = ratingSelect ? Number(ratingSelect.value) : 0;

  const matches = recommendations.filter((item) => {
    if (!item || item.verified !== false) {
      return false;
    }

    if (item.availabilityStatus !== "tmdb-suggested") {
      return false;
    }

    return hasMatch(item, "regions", "region", selectedRegion)
      && hasMatch(item, "platforms", "platform", selectedPlatform)
      && hasMatch(item, "type", "type", selectedType)
      && hasMatch(item, "genres", "genre", selectedGenre)
      && hasMinimumRating(item, selectedRating);
  });

  const sorted = sortCandidates(matches);

  if (sorted.length === 0) {
    activeResults = [];
    visibleResultCount = 0;
    resultsGrid.dataset.resultCount = "0";
    resultContextEl.textContent = "";
    setShowMoreState(false, 0, 0);
    showEmptyState(
      "No TMDB candidates found for this filter combination.",
      "Try another genre or platform. This candidate pool is still growing, so some combinations simply do not have matches yet."
    );
    setStatus("No matching TMDB candidates for the current selection.");
    return;
  }

  activeResults = sorted;
  visibleResultCount = Math.min(INITIAL_RESULT_COUNT, activeResults.length);
  renderVisibleResults();
  setStatus("Showing TMDB candidates for the current selection.");
}

function createCard(item) {
  const card = document.createElement("article");
  card.className = "card";

  const title = getText(item, ["title", "name"], "Untitled recommendation");
  const year = getText(item, ["year", "releaseYear"], "Unknown year");
  const type = getText(item, ["type", "mediaType"], "Unknown type");
  const platform = joinValues(item, ["platforms", "platform"]);
  const genres = joinValues(item, ["genres", "genre"]);
  const rating = getText(item, ["rating", "score"], "No rating");
  const moodTags = getMoodTags(item);
  const blurb = getText(item, ["shortBlurb", "tmdbOverview", "blurb", "summary", "description"], "");
  const posterUrl = getText(item, ["posterUrl"], "");
  const ratingValue = formatRating(item.rating ?? item.voteAverage ?? item.vote_count ?? rating);

  const hasBlurb = blurb.trim() !== "";
  const blurbText = hasBlurb
    ? blurb
    : "A TMDB candidate for this filter combination, ready to explore when you are.";

  const blurbClass = hasBlurb ? "blurb" : "blurb is-fallback";
  const blurbId = "card-blurb-" + String(item.tmdbId || item.id || title).replace(/[^a-zA-Z0-9_-]+/g, "-");
  const posterMarkup = posterUrl
    ? '<div class="card-poster"><img src="' +
      escapeHtml(posterUrl) +
      '" alt="' +
      escapeHtml(title + " poster") +
      '" loading="lazy" decoding="async" /></div>'
    : "";

  card.innerHTML =
    posterMarkup +
    '<div class="card-body">' +
    '<div class="card-title-row">' +
    '<span class="card-marker" aria-hidden="true"></span>' +
    "<h2>" + escapeHtml(title) + "</h2>" +
    "</div>" +
    '<div class="meta">' +
    "<span>Year: " + escapeHtml(year) + "</span>" +
    "<span>|</span>" +
    "<span>Type: " + escapeHtml(type) + "</span>" +
    "<span>|</span>" +
    "<span>Platform: " + escapeHtml(platform || "Unknown platform") + "</span>" +
    "</div>" +
    '<div class="pill-row">' +
    renderPills("Rating", ratingValue) +
    renderPills("Genres", genres) +
    (moodTags.length > 0 ? renderPills("Mood tags", moodTags) : "") +
    "</div>" +
    '<div class="card-blurb-wrap" data-state="collapsed" data-has-toggle="false">' +
    '<div class="card-blurb-text">' +
    '<p id="' + escapeHtml(blurbId) + '" class="' + blurbClass + '">' + escapeHtml(blurbText) + "</p>" +
    "</div>" +
    '<div class="card-blurb-spacer" aria-hidden="true"></div>' +
    '<div class="card-blurb-toggle-row">' +
    '<button class="blurb-toggle" type="button" aria-expanded="false" aria-controls="' +
    escapeHtml(blurbId) +
    '" aria-label="Expand description">' +
    '<span class="blurb-toggle-icon" aria-hidden="true"></span>' +
    "</button>" +
    "</div>" +
    "</div>" +
    "</div>";

  return card;
}

function renderPills(label, value) {
  const items = asArray(value).slice(0, 6);
  if (items.length === 0) {
    return '<span class="pill pill-muted">' + escapeHtml(label + ": none listed") + "</span>";
  }

  const pills = '<span class="pill pill-label">' + escapeHtml(label + ":") + "</span>";
  return pills + items.map((entry) => '<span class="pill">' + escapeHtml(String(entry)) + "</span>").join("");
}

function sortCandidates(items) {
  return items.slice().sort((left, right) => {
    const leftRating = getSortableRating(left);
    const rightRating = getSortableRating(right);
    if (rightRating !== leftRating) {
      return rightRating - leftRating;
    }

    const leftTitle = getText(left, ["title", "name"], "").trim().toLowerCase();
    const rightTitle = getText(right, ["title", "name"], "").trim().toLowerCase();
    const titleCompare = leftTitle.localeCompare(rightTitle);
    if (titleCompare !== 0) {
      return titleCompare;
    }

    const leftYear = Number(getText(left, ["year", "releaseYear"], 0));
    const rightYear = Number(getText(right, ["year", "releaseYear"], 0));
    if (Number.isFinite(rightYear) && Number.isFinite(leftYear) && rightYear !== leftYear) {
      return rightYear - leftYear;
    }

    return 0;
  });
}

function getSortableRating(item) {
  const numeric = Number(item && (item.rating ?? item.voteAverage ?? item.score));
  return Number.isFinite(numeric) ? numeric : -Infinity;
}

function getMoodTags(item) {
  return asArray(item && (item.moodTags || item.moods || item.tags))
    .map((value) => String(value).trim())
    .filter((value) => value !== "" && value.toLowerCase() !== "none listed");
}

function showEmptyState(title, message) {
  resultsGrid.innerHTML =
    '<div class="empty-state">' +
    "<strong>" + escapeHtml(title) + "</strong>" +
    "<div>" + escapeHtml(message) + "</div>" +
    '<div class="hint">Try another verified platform or genre to see a different match.</div>' +
    "</div>";
}

function clearResults() {
  activeResults = [];
  visibleResultCount = 0;
  resultsGrid.dataset.resultCount = "0";
  resultsGrid.innerHTML = "";
  resultContextEl.textContent = "";
  setStatus("");
  setShowMoreState(false, 0, 0);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setRevealButtonState(hasResults) {
  revealButton.textContent = hasResults ? "Reveal again" : "Reveal recommendations";
}

function renderVisibleResults() {
  const visibleItems = activeResults.slice(0, visibleResultCount);
  resultsGrid.dataset.resultCount = String(visibleItems.length);
  resultsGrid.innerHTML = "";
  resultContextEl.textContent =
    "Showing " + visibleItems.length + " of " + activeResults.length + " matching candidates.";

  visibleItems.forEach((item) => {
    resultsGrid.appendChild(createCard(item));
  });

  updateDescriptionStates();
  setShowMoreState(visibleResultCount < activeResults.length, visibleResultCount, activeResults.length);
}

function setShowMoreState(isVisible) {
  if (!showMoreButton) {
    return;
  }

  showMoreButton.hidden = !isVisible;
  showMoreButton.disabled = !isVisible;
  showMoreButton.textContent = "Show more";
}

function hasMatch(item, pluralKey, singularKey, selectedValue) {
  if (!selectedValue) {
    return true;
  }

  const values = asArray(item[pluralKey] || item[singularKey]).map((value) => String(value));
  return values.indexOf(selectedValue) !== -1;
}

function hasMinimumRating(item, threshold) {
  if (!threshold) {
    return true;
  }

  const numeric = Number(item && (item.rating ?? item.voteAverage ?? item.score));
  return Number.isFinite(numeric) && numeric >= threshold;
}

function joinValues(item, keys) {
  for (let index = 0; index < keys.length; index += 1) {
    const values = asArray(item[keys[index]]);
    if (values.length > 0) {
      return values.join(", ");
    }
  }

  return "";
}

function getText(item, keys, fallback) {
  for (let index = 0; index < keys.length; index += 1) {
    const value = item[keys[index]];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value);
    }
  }

  return fallback;
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== null && entry !== undefined && String(entry).trim() !== "");
  }

  if (value === null || value === undefined || value === "") {
    return [];
  }

  return [value];
}

function shuffle(items) {
  const copy = items.slice();

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = temp;
  }

  return copy;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRating(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "No rating";
  }
  return numeric.toFixed(1);
}

function updateDescriptionStates() {
  const cards = Array.from(resultsGrid.querySelectorAll(".card"));

  cards.forEach((card) => {
    const wrap = card.querySelector(".card-blurb-wrap");
    const text = card.querySelector(".card-blurb-text");
    const button = card.querySelector(".blurb-toggle");
    if (!wrap || !text || !button) {
      return;
    }

    const lineHeight = parseFloat(getComputedStyle(text.querySelector(".blurb")).lineHeight || "0");
    const collapsedHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight * 3 : 72;
    const needsToggle = text.scrollHeight > collapsedHeight + 2;

    wrap.dataset.hasToggle = needsToggle ? "true" : "false";
    wrap.dataset.state = needsToggle ? "collapsed" : "expanded";
    button.hidden = !needsToggle;

    if (!needsToggle) {
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", "Expand description");
      return;
    }

    button.setAttribute("aria-expanded", wrap.dataset.state === "expanded" ? "true" : "false");
    button.setAttribute("aria-label", wrap.dataset.state === "expanded" ? "Collapse description" : "Expand description");

    button.onclick = () => {
      const isExpanded = wrap.dataset.state === "expanded";
      wrap.dataset.state = isExpanded ? "collapsed" : "expanded";
      button.setAttribute("aria-expanded", isExpanded ? "false" : "true");
      button.setAttribute("aria-label", isExpanded ? "Expand description" : "Collapse description");
    };
  });
}

function ensureTmdbAttribution() {
  const resultsSection = resultsGrid && resultsGrid.closest(".results");
  if (!resultsSection || tmdbAttributionEl) {
    return;
  }

  tmdbAttributionEl = document.createElement("p");
  tmdbAttributionEl.className = "tmdb-attribution";
  tmdbAttributionEl.textContent = TMDB_ATTRIBUTION;
  resultsSection.appendChild(tmdbAttributionEl);
}
