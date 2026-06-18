const DATA_URL = "data/candidates.with-imdb.json";

const regionControl = document.getElementById("region-select");
const regionToggle = document.getElementById("region-toggle");
const regionPanel = document.getElementById("region-panel");
const regionSummaryEl = document.getElementById("region-summary");
const platformControl = document.getElementById("platform-select");
const platformToggle = document.getElementById("platform-toggle");
const platformPanel = document.getElementById("platform-panel");
const platformSummaryEl = document.getElementById("platform-summary");
const typeControl = document.getElementById("type-select");
const typeToggle = document.getElementById("type-toggle");
const typePanel = document.getElementById("type-panel");
const typeSummaryEl = document.getElementById("type-summary");
const formatControl = document.getElementById("format-select");
const formatToggle = document.getElementById("format-toggle");
const formatPanel = document.getElementById("format-panel");
const formatSummaryEl = document.getElementById("format-summary");
const genreControl = document.getElementById("genre-select");
const genreToggle = document.getElementById("genre-toggle");
const genrePanel = document.getElementById("genre-panel");
const genreSummaryEl = document.getElementById("genre-summary");
const ratingControl = document.getElementById("rating-select");
const ratingToggle = document.getElementById("rating-toggle");
const ratingPanel = document.getElementById("rating-panel");
const ratingSummaryEl = document.getElementById("rating-summary");
const revealButton = document.getElementById("reveal-button");
const shuffleButton = document.getElementById("shuffle-button");
const savedOnlyButton = document.getElementById("saved-only-button");
const resultsGrid = document.getElementById("results-grid");
const showMoreButton = document.getElementById("show-more-button");
const statusEl = document.getElementById("status");
const resultContextEl = document.getElementById("result-context");
const eyebrowEl = document.querySelector(".eyebrow");

const VERSION_LABEL = "N1GHTVISION V1.0";
const TMDB_ATTRIBUTION =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";
const REGION_LABELS = {
  AT: "Austria",
  US: "United States"
};
const SAVED_TITLES_STORAGE_KEY = "n1ghtvision.savedTitles.v1";

let tmdbAttributionEl = null;

let recommendations = [];
let revealedOnce = false;
let currentResultMode = "sorted";
let savedOnlyActive = false;
let savedTitleIds = loadSavedTitleIds();
let activeResults = [];
let visibleResultCount = 0;
let filterOptions = {
  region: [],
  platform: [],
  type: [],
  formatStyle: [],
  rating: []
};
let selectedFilterValues = {
  region: "",
  platform: "",
  type: "",
  formatStyle: "",
  rating: ""
};
let platformOptionValues = [];
let selectedPlatforms = new Set();
let genreOptionValues = [];
let selectedGenres = new Set();
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

  populateSingleSelectControl(regionControl, regionPanel, regionSummaryEl, "region", collectValues(recommendations, ["regions", "region"]), { defaultLabel: "All Regions", displayValue: (value) => REGION_LABELS[value] || value });
  populateSingleSelectControl(typeControl, typePanel, typeSummaryEl, "type", collectValues(recommendations, ["type", "mediaType"]), { defaultLabel: "All Types" });
  populateSingleSelectControl(formatControl, formatPanel, formatSummaryEl, "formatStyle", collectValues(recommendations, ["formatStyle"]), { defaultLabel: "All Formats" });
  populatePlatformControl(platformControl, platformPanel, platformSummaryEl, collectValues(recommendations, ["platforms", "platform"], canonicalPlatformName));
  populateGenreControl(genreControl, collectValues(recommendations, ["genres", "genre"]));
  populateSingleSelectControl(ratingControl, ratingPanel, ratingSummaryEl, "rating", ["7", "8", "9"], { defaultLabel: "All Ratings", displayValue: (value) => value + ".0+" });

  const hasPresetFilters = applyUrlPresetFilters();

  setStatus("Choose filters, then reveal matching TMDB candidates.");
  setMainButtonState(false);
  setShuffleButtonState(false);
  setSavedOnlyButtonState(savedOnlyActive);
  clearResults();
  setShowMoreState(false, 0, 0);

  setupDropdownControl(regionControl, regionToggle, regionPanel, "region");
  setupDropdownControl(platformControl, platformToggle, platformPanel, "platform");
  setupDropdownControl(typeControl, typeToggle, typePanel, "type");
  setupDropdownControl(formatControl, formatToggle, formatPanel, "formatStyle");
  setupDropdownControl(ratingControl, ratingToggle, ratingPanel, "rating");

  if (platformToggle && platformPanel) {
    platformPanel.addEventListener("change", () => {
      updateSelectedPlatformsFromPanel();
      if (revealedOnce || savedOnlyActive) {
        renderRecommendations("sorted");
      } else {
        clearResults();
      }

      syncFilterUrl();
    });
  }

  if (genreToggle && genrePanel) {
    genreToggle.addEventListener("click", () => {
      toggleGenrePanel();
    });

    genrePanel.addEventListener("change", () => {
      updateSelectedGenresFromPanel();
      if (revealedOnce || savedOnlyActive) {
        renderRecommendations("sorted");
      } else {
        clearResults();
      }

      syncFilterUrl();
    });

    document.addEventListener("click", (event) => {
      if (!genreControl || !genreControl.contains(event.target)) {
        closeGenrePanel();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeGenrePanel();
      }
    });
  }

  revealButton.addEventListener("click", () => {
    revealedOnce = true;
    renderRecommendations("sorted");
  });

  if (shuffleButton) {
    shuffleButton.addEventListener("click", () => {
      if (!revealedOnce || activeResults.length === 0) {
        return;
      }

      renderRecommendations("shuffle");
    });
  }

  if (savedOnlyButton) {
    savedOnlyButton.addEventListener("click", () => {
      savedOnlyActive = !savedOnlyActive;
      setSavedOnlyButtonState(savedOnlyActive);

      if (savedOnlyActive || revealedOnce) {
        renderRecommendations(savedOnlyActive ? currentResultMode : "sorted");
      } else {
        clearResults();
      }
    });
  }

  resultsGrid.addEventListener("click", (event) => {
    const button = event.target && typeof event.target.closest === "function" ? event.target.closest(".card-save-button") : null;
    if (!button) {
      return;
    }

    const candidateId = String(button.getAttribute("data-candidate-id") || "");
    if (!candidateId) {
      return;
    }

    toggleSavedTitle(candidateId);
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

  if (hasPresetFilters) {
    revealedOnce = true;
    renderRecommendations("sorted");
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

function populateGenreControl(control, values) {
  if (!genrePanel) {
    return;
  }

  genreOptionValues = values.filter((value) => String(value || "").trim() !== "");
  genrePanel.innerHTML = "";

  if (genreOptionValues.length === 0) {
    const empty = document.createElement("p");
    empty.className = "genre-panel-empty";
    empty.textContent = "No genres available.";
    genrePanel.appendChild(empty);
    updateGenreSummary();
    return;
  }

  const optionList = document.createElement("div");
  optionList.className = "genre-option-list";

  const hint = document.createElement("p");
  hint.className = "genre-panel-hint";
  hint.textContent = "choose one or more";
  genrePanel.appendChild(hint);

  genreOptionValues.forEach((value, index) => {
    const optionId = "genre-option-" + String(index);
    const option = document.createElement("label");
    option.className = "genre-option";
    option.setAttribute("for", optionId);

    const checkbox = document.createElement("input");
    checkbox.id = optionId;
    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.checked = selectedGenres.has(value);
    checkbox.dataset.genreValue = value;

    const text = document.createElement("span");
    text.className = "genre-option-label";
    text.textContent = value;

    option.appendChild(checkbox);
    option.appendChild(text);
    optionList.appendChild(option);
  });

  const actions = document.createElement("div");
  actions.className = "genre-panel-actions";

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "genre-panel-action";
  clearButton.textContent = "Clear";
  clearButton.addEventListener("click", () => {
    selectedGenres = new Set();
    syncGenreSelectionUI();
    if (revealedOnce || savedOnlyActive) {
      renderRecommendations("sorted");
    } else {
      clearResults();
    }
    syncFilterUrl();
  });

  actions.appendChild(clearButton);
  genrePanel.appendChild(optionList);
  genrePanel.appendChild(actions);
  syncGenreSelectionUI();
}

function populatePlatformControl(control, panel, summaryEl, values) {
  if (!panel) {
    return;
  }

  platformOptionValues = values.filter((value) => String(value || "").trim() !== "");
  panel.innerHTML = "";

  if (platformOptionValues.length === 0) {
    const empty = document.createElement("p");
    empty.className = "genre-panel-empty";
    empty.textContent = "No platforms available.";
    panel.appendChild(empty);
    updatePlatformSummary();
    return;
  }

  const optionList = document.createElement("div");
  optionList.className = "genre-option-list";

  const hint = document.createElement("p");
  hint.className = "genre-panel-hint";
  hint.textContent = "choose one or more";
  panel.appendChild(hint);

  platformOptionValues.forEach((value, index) => {
    const optionId = "platform-option-" + String(index);
    const option = document.createElement("label");
    option.className = "genre-option";
    option.setAttribute("for", optionId);

    const checkbox = document.createElement("input");
    checkbox.id = optionId;
    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.checked = selectedPlatforms.has(value);
    checkbox.dataset.platformValue = value;

    const text = document.createElement("span");
    text.className = "genre-option-label";
    text.textContent = value;

    option.appendChild(checkbox);
    option.appendChild(text);
    optionList.appendChild(option);
  });

  const actions = document.createElement("div");
  actions.className = "genre-panel-actions";

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "genre-panel-action";
  clearButton.textContent = "Clear";
  clearButton.addEventListener("click", () => {
    selectedPlatforms = new Set();
    syncPlatformSelectionUI();
    if (revealedOnce || savedOnlyActive) {
      renderRecommendations("sorted");
    } else {
      clearResults();
    }
    syncFilterUrl();
  });

  actions.appendChild(clearButton);
  panel.appendChild(optionList);
  panel.appendChild(actions);
  updatePlatformSummary();
}

function applyUrlPresetFilters() {
  const params = new URLSearchParams(window.location.search);
  let appliedCount = 0;

  appliedCount += applyPresetFilterValue("region", params.get("region"));
  appliedCount += applyPresetFilterValue("type", params.get("type"));
  appliedCount += applyPresetFilterValue("formatStyle", params.get("format"));
  appliedCount += applyPresetPlatforms(params.getAll("platform"));
  appliedCount += applyPresetGenres(params.getAll("genre"));
  appliedCount += applyPresetFilterValue("rating", params.get("rating"));

  return appliedCount > 0;
}

function applyPresetFilterValue(key, value) {
  if (value === null || value === undefined) {
    return 0;
  }

  const normalizedValue = String(value).trim();
  if (normalizedValue === "") {
    return 0;
  }

  const allowedValues = filterOptions[key] || [];
  const hasMatchingOption = allowedValues.some((option) => option.value === normalizedValue);
  if (!hasMatchingOption) {
    return 0;
  }

  selectedFilterValues[key] = normalizedValue;
  syncSingleSelectUI(key);
  return 1;
}

function syncFilterUrl() {
  const params = new URLSearchParams();
  addFilterParam(params, "region", selectedFilterValues.region);
  addFilterParam(params, "type", selectedFilterValues.type);
  addFilterParam(params, "format", selectedFilterValues.formatStyle);
  addPlatformParams(params, getSelectedPlatformValues());
  addGenreParams(params, getSelectedGenreValues());
  addFilterParam(params, "rating", selectedFilterValues.rating);

  const nextUrl = params.toString() ? window.location.pathname + "?" + params.toString() + window.location.hash : window.location.pathname + window.location.hash;
  window.history.replaceState(null, "", nextUrl);
}

function addFilterParam(params, key, value) {
  const normalizedValue = String(value || "").trim();
  if (normalizedValue === "") {
    return;
  }

  params.set(key, normalizedValue);
}

function addGenreParams(params, values) {
  asArray(values).forEach((value) => {
    const normalizedValue = String(value || "").trim();
    if (normalizedValue === "") {
      return;
    }

    params.append("genre", normalizedValue);
  });
}

function addPlatformParams(params, values) {
  asArray(values).forEach((value) => {
    const normalizedValue = String(value || "").trim();
    if (normalizedValue === "") {
      return;
    }

    params.append("platform", normalizedValue);
  });
}

function collectValues(items, keys, transform) {
  const values = new Set();

  items.forEach((item) => {
    keys.forEach((key) => {
      asArray(item && item[key]).forEach((value) => {
        const normalizedValue = typeof transform === "function" ? transform(value) : String(value);
        if (normalizedValue !== null && normalizedValue !== undefined && String(normalizedValue).trim() !== "") {
          values.add(String(normalizedValue));
        }
      });
    });
  });

  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function renderRecommendations(mode = "sorted", options = {}) {
  const selectedRegion = selectedFilterValues.region;
  const selectedPlatformValues = getSelectedPlatformValues();
  const selectedType = selectedFilterValues.type;
  const selectedFormat = selectedFilterValues.formatStyle;
  const selectedGenreValues = getSelectedGenreValues();
  const selectedRating = Number(selectedFilterValues.rating || 0);

  const matches = recommendations.filter((item) => {
    if (!item || item.verified !== false) {
      return false;
    }

    if (item.availabilityStatus !== "tmdb-suggested") {
      return false;
    }

    return hasAvailabilityMatch(item, selectedRegion, selectedPlatformValues)
      && hasMatch(item, "type", "type", selectedType)
      && hasMatch(item, "formatStyle", "formatStyle", selectedFormat)
      && hasGenreMatch(item, selectedGenreValues)
      && hasMinimumRating(item, selectedRating);
  });

  const filteredMatches = savedOnlyActive ? matches.filter((item) => isSavedCandidate(item)) : matches;

  if (savedOnlyActive && savedTitleIds.size === 0) {
    activeResults = [];
    visibleResultCount = 0;
    resultsGrid.dataset.resultCount = "0";
    resultContextEl.textContent = "";
    setShowMoreState(false, 0, 0);
    showEmptyState(
      "No saved titles yet.",
      "Save titles from Discover mode to build your watchlist."
    );
    setStatus("Watchlist: no saved titles yet.");
    return;
  }

  currentResultMode = mode === "shuffle" ? "shuffle" : "sorted";
  const ordered = currentResultMode === "shuffle" ? shuffle(filteredMatches) : sortCandidates(filteredMatches);

  setMainButtonState(true);
  setShuffleButtonState(revealedOnce && ordered.length > 0);

  if (ordered.length === 0) {
    activeResults = [];
    visibleResultCount = 0;
    resultsGrid.dataset.resultCount = "0";
    resultContextEl.textContent = "";
    setShowMoreState(false, 0, 0);
    if (savedOnlyActive) {
      showEmptyState(
        "No saved titles match the current filters.",
        "Try another filter combination or turn off Saved only to browse Discover mode."
      );
      setStatus("No saved titles match the current selection.");
    } else {
      showEmptyState(
        "No TMDB candidates found for this filter combination.",
        "Try another genre or platform. This candidate pool is still growing, so some combinations simply do not have matches yet."
      );
      setStatus("No matching TMDB candidates for the current selection.");
    }
    return;
  }

  activeResults = ordered;
  if (options.preserveVisibleCount) {
    const preservedCount = visibleResultCount > 0 ? visibleResultCount : INITIAL_RESULT_COUNT;
    visibleResultCount = Math.min(preservedCount, activeResults.length);
  } else {
    visibleResultCount = Math.min(INITIAL_RESULT_COUNT, activeResults.length);
  }
  renderVisibleResults();
  setStatus(getModeStatusText(activeResults.length, currentResultMode));
}

function createCard(item) {
  const card = document.createElement("article");
  card.className = "card";

  const title = getText(item, ["title", "name"], "Untitled recommendation");
  const year = getText(item, ["year", "releaseYear"], "Unknown year");
  const type = getText(item, ["type", "mediaType"], "Unknown type");
  const candidateId = getCandidateSaveId(item);
  const platformValues = getPlatformValues(item);
  const platformDisplay = formatPlatformDisplay(platformValues);
  const genres = joinValues(item, ["genres", "genre"]);
  const moodTags = getMoodTags(item);
  const blurb = getText(item, ["shortBlurb", "tmdbOverview", "blurb", "summary", "description"], "");
  const posterUrl = getText(item, ["posterUrl"], "");
  const ratingValue = formatRating(getEffectiveRating(item));
  const imdbId = getText(item, ["imdbId"], "");
  const imdbRating = Number(item && item.imdbRating);
  const ratingBadge = renderRatingBadge(imdbId, imdbRating, ratingValue);

  const hasBlurb = blurb.trim() !== "";
  const blurbText = hasBlurb
    ? blurb
    : "A TMDB candidate for this filter combination, ready to explore when you are.";

  const blurbClass = hasBlurb ? "blurb" : "blurb is-fallback";
  const blurbId = "card-blurb-" + String(item.tmdbId || item.id || title).replace(/[^a-zA-Z0-9_-]+/g, "-");
  const isSaved = candidateId ? savedTitleIds.has(candidateId) : false;
  const saveButtonMarkup = candidateId
    ? '<button class="card-save-button mini-toggle" type="button" data-candidate-id="' +
      escapeHtml(candidateId) +
      '" aria-pressed="' +
      (isSaved ? "true" : "false") +
      '" aria-label="' +
      escapeHtml(isSaved ? "Remove from saved items" : "Save title") +
      '">' +
      escapeHtml(isSaved ? "Saved" : "Save") +
      "</button>"
    : "";
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
    saveButtonMarkup +
    "</div>" +
    '<div class="meta">' +
    "<span>Year: " + escapeHtml(year) + "</span>" +
    "<span>|</span>" +
    "<span>Type: " + escapeHtml(type) + "</span>" +
    "<span>|</span>" +
    '<span class="card-platform-line" data-platforms="' +
    escapeHtml(JSON.stringify(platformValues)) +
    '">' +
    escapeHtml(platformDisplay) +
    "</span>" +
    "</div>" +
    '<div class="pill-row pill-row-rating">' +
    ratingBadge +
    "</div>" +
    '<div class="pill-row pill-row-genres">' +
    renderGenrePill(genres) +
    "</div>" +
    (moodTags.length > 0
      ? '<div class="pill-row pill-row-moods">' + renderPills("Mood tags", moodTags) + "</div>"
      : "") +
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

function renderGenrePill(value) {
  const items = asArray(value).slice(0, 6);
  const text = items.length === 0 ? "Genres: none listed" : "Genres: " + items.join(", ");
  return '<span class="pill pill-genre">' + escapeHtml(text) + "</span>";
}

function renderRatingBadge(imdbId, imdbRating, tmdbRatingValue) {
  if (imdbId && Number.isFinite(imdbRating)) {
    const imdbText = "IMDb " + formatRating(imdbRating) + " " + String.fromCharCode(8599);
    return (
      '<a class="pill rating-pill rating-pill-link" href="https://www.imdb.com/title/' +
      escapeHtml(imdbId) +
      '/" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(imdbText) +
      "</a>"
    );
  }

  return '<span class="pill rating-pill">' + escapeHtml("TMDB " + tmdbRatingValue) + "</span>";
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
  const numeric = getEffectiveRating(item);
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

function setMainButtonState(hasResults) {
  revealButton.textContent = hasResults ? "Update results" : "Show results";
}

function setShuffleButtonState(isVisible) {
  if (!shuffleButton) {
    return;
  }

  shuffleButton.hidden = !isVisible;
  shuffleButton.disabled = !isVisible;
}

function formatResultContextText(visibleCount, totalCount, mode) {
  const suffix = mode === "shuffle"
    ? (savedOnlyActive ? "shuffled saved candidates" : "shuffled candidates")
    : (savedOnlyActive ? "saved candidates" : "matching candidates");
  return "Showing " + visibleCount + " of " + totalCount + " " + suffix + ".";
}

function renderVisibleResults() {
  const visibleItems = activeResults.slice(0, visibleResultCount);
  resultsGrid.dataset.resultCount = String(visibleItems.length);
  resultsGrid.innerHTML = "";
  resultContextEl.textContent = formatResultContextText(visibleItems.length, activeResults.length, currentResultMode);

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

function setSavedOnlyButtonState(isActive) {
  if (!savedOnlyButton) {
    return;
  }

  savedOnlyButton.setAttribute("aria-pressed", isActive ? "true" : "false");
  savedOnlyButton.setAttribute("aria-label", isActive ? "Hide watchlist" : "Show watchlist");
  savedOnlyButton.setAttribute("title", isActive ? "Hide watchlist" : "Show watchlist");
  savedOnlyButton.classList.toggle("is-active", isActive);
}

function getModeStatusText(totalCount, mode) {
  if (savedOnlyActive) {
    return "Watchlist: " + formatCount(totalCount, "saved title", "saved titles");
  }

  if (mode === "shuffle") {
    return "Showing " + formatCount(totalCount, "shuffled match", "shuffled matches");
  }

  return "Showing " + formatCount(totalCount, "match", "matches");
}

function formatCount(value, singular, plural) {
  return value + " " + (value === 1 ? singular : plural);
}

function toggleSavedTitle(candidateId) {
  if (!candidateId) {
    return;
  }

  if (savedTitleIds.has(candidateId)) {
    savedTitleIds.delete(candidateId);
  } else {
    savedTitleIds.add(candidateId);
  }

  persistSavedTitleIds();

  if (revealedOnce) {
    renderRecommendations(currentResultMode, { preserveVisibleCount: true });
  }
}

function isSavedCandidate(item) {
  const candidateId = getCandidateSaveId(item);
  return candidateId ? savedTitleIds.has(candidateId) : false;
}

function getCandidateSaveId(item) {
  return String(item && item.id ? item.id : "");
}

function loadSavedTitleIds() {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return new Set();
  }

  try {
    const raw = storage.getItem(SAVED_TITLES_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.map((value) => String(value).trim()).filter((value) => value !== ""));
  } catch (error) {
    return new Set();
  }
}

function persistSavedTitleIds() {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SAVED_TITLES_STORAGE_KEY, JSON.stringify(Array.from(savedTitleIds).sort()));
  } catch (error) {
    // Ignore storage failures so watchlist changes stay local to this session.
  }
}

function getSafeLocalStorage() {
  try {
    if (typeof localStorage === "undefined") {
      return null;
    }

    const probeKey = "__n1ghtvision_storage_probe__";
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
    return localStorage;
  } catch (error) {
    return null;
  }
}

function hasMatch(item, pluralKey, singularKey, selectedValue) {
  if (!selectedValue) {
    return true;
  }

  const values = asArray(item[pluralKey] || item[singularKey]).map((value) => String(value));
  return values.indexOf(selectedValue) !== -1;
}

function hasGenreMatch(item, selectedGenresToMatch) {
  if (!Array.isArray(selectedGenresToMatch) || selectedGenresToMatch.length === 0) {
    return true;
  }

  const values = asArray(item && (item.genres || item.genre))
    .map((value) => String(value).trim())
    .filter((value) => value !== "");

  if (values.length === 0) {
    return false;
  }

  const selectedSet = new Set(selectedGenresToMatch.map((value) => String(value).trim()).filter((value) => value !== ""));
  return values.some((value) => selectedSet.has(value));
}

function populateSingleSelectControl(control, panel, summaryEl, key, values, options = {}) {
  const defaultLabel = options.defaultLabel || "All";
  const displayValue = typeof options.displayValue === "function" ? options.displayValue : (value) => value;
  const normalizedValues = Array.isArray(values) ? values.map((value) => String(value || "").trim()).filter((value) => value !== "") : [];
  const optionList = [];
  const seen = new Set();

  if (!filterOptions[key]) {
    filterOptions[key] = [];
  }

  filterOptions[key] = [];
  normalizedValues.forEach((value) => {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    filterOptions[key].push({ value, label: displayValue(value) });
  });

  if (panel) {
    panel.innerHTML = "";
    const list = document.createElement("div");
    list.className = "genre-option-list";

    const allItem = createSingleSelectOption(key, "", defaultLabel);
    list.appendChild(allItem);

    filterOptions[key].forEach((entry) => {
      list.appendChild(createSingleSelectOption(key, entry.value, entry.label));
    });

    panel.appendChild(list);
  }

  selectedFilterValues[key] = selectedFilterValues[key] || "";
  if (summaryEl) {
    updateSingleSelectSummary(key, defaultLabel, summaryEl);
  }
}

function createSingleSelectOption(key, value, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "genre-option genre-option-button";
  button.dataset.filterKey = key;
  button.dataset.filterValue = value;
  button.textContent = label;
  button.addEventListener("click", () => {
    selectedFilterValues[key] = value;
    syncSingleSelectUI(key);
    closeDropdownPanel(key);
    if (revealedOnce || savedOnlyActive) {
      renderRecommendations("sorted");
    } else {
      clearResults();
    }
    syncFilterUrl();
  });
  return button;
}

function setupDropdownControl(control, toggle, panel, key) {
  if (!control || !toggle || !panel) {
    return;
  }

  toggle.addEventListener("click", () => {
    const isOpen = control.classList.contains("is-open");
    if (isOpen) {
      closeDropdownPanel(key);
    } else {
      openDropdownPanel(key);
    }
  });

  document.addEventListener("click", (event) => {
    if (!control.contains(event.target)) {
      closeDropdownPanel(key);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDropdownPanel(key);
    }
  });
}

function syncSingleSelectUI(key) {
  const config = getDropdownConfig(key);
  if (!config) {
    return;
  }

  const selectedValue = selectedFilterValues[key] || "";
  const buttons = Array.from(config.panel.querySelectorAll("button[data-filter-value]"));
  buttons.forEach((button) => {
    const isSelected = button.dataset.filterValue === selectedValue;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", isSelected ? "true" : "false");
  });

  updateSingleSelectSummary(key, config.defaultLabel, config.summaryEl);
}

function updateSingleSelectSummary(key, defaultLabel, summaryEl) {
  if (!summaryEl) {
    return;
  }

  const selectedValue = selectedFilterValues[key] || "";
  if (!selectedValue) {
    summaryEl.textContent = defaultLabel;
    return;
  }

  const config = getDropdownConfig(key);
  const entry = config && config.options.find((item) => item.value === selectedValue);
  summaryEl.textContent = entry ? entry.label : selectedValue;
}

function openDropdownPanel(key) {
  const config = getDropdownConfig(key);
  if (!config) {
    return;
  }

  config.panel.hidden = false;
  config.control.classList.add("is-open");
  config.toggle.setAttribute("aria-expanded", "true");
}

function closeDropdownPanel(key) {
  const config = getDropdownConfig(key);
  if (!config) {
    return;
  }

  config.panel.hidden = true;
  config.control.classList.remove("is-open");
  config.toggle.setAttribute("aria-expanded", "false");
}

function closeAllDropdownPanels() {
  ["region", "platform", "type", "formatStyle", "rating", "genre"].forEach((key) => closeDropdownPanel(key));
}

function getDropdownConfig(key) {
  const map = {
    region: { control: regionControl, toggle: regionToggle, panel: regionPanel, summaryEl: regionSummaryEl, defaultLabel: "All Regions", options: filterOptions.region || [] },
    platform: { control: platformControl, toggle: platformToggle, panel: platformPanel, summaryEl: platformSummaryEl, defaultLabel: "All Platforms", options: filterOptions.platform || [] },
    type: { control: typeControl, toggle: typeToggle, panel: typePanel, summaryEl: typeSummaryEl, defaultLabel: "All Types", options: filterOptions.type || [] },
    formatStyle: { control: formatControl, toggle: formatToggle, panel: formatPanel, summaryEl: formatSummaryEl, defaultLabel: "All Formats", options: filterOptions.formatStyle || [] },
    rating: { control: ratingControl, toggle: ratingToggle, panel: ratingPanel, summaryEl: ratingSummaryEl, defaultLabel: "All Ratings", options: filterOptions.rating || [] },
    genre: { control: genreControl, toggle: genreToggle, panel: genrePanel, summaryEl: genreSummaryEl, defaultLabel: "All Genres", options: genreOptionValues.map((value) => ({ value, label: value })) }
  };

  return map[key] || null;
}

function hasAvailabilityMatch(item, selectedRegion, selectedPlatform) {
  if (!selectedRegion && (!Array.isArray(selectedPlatform) || selectedPlatform.length === 0)) {
    return true;
  }

  const availability = Array.isArray(item && item.availability) ? item.availability : [];
  const selectedPlatformSet = new Set(asArray(selectedPlatform).map((value) => String(value).trim()).filter((value) => value !== ""));
  return availability.some((entry) => {
    if (!entry) {
      return false;
    }

    const regionMatches = !selectedRegion || entry.region === selectedRegion;
    const platformName = canonicalPlatformName(entry.platform);
    const platformMatches = selectedPlatformSet.size === 0 || selectedPlatformSet.has(platformName);
    return regionMatches && platformMatches;
  });
}

function hasMinimumRating(item, threshold) {
  if (!threshold) {
    return true;
  }

  const numeric = getEffectiveRating(item);
  return Number.isFinite(numeric) && numeric >= threshold;
}

function applyPresetGenres(values) {
  if (!Array.isArray(values) || values.length === 0) {
    selectedGenres = new Set();
    syncGenreSelectionUI();
    return 0;
  }

  const allowed = new Map(genreOptionValues.map((value) => [normalizeText(value), value]));
  const nextSelected = [];
  const seen = new Set();

  values.forEach((rawValue) => {
    const normalizedValue = String(rawValue || "").trim();
    if (normalizedValue === "") {
      return;
    }

    const resolvedValue = allowed.get(normalizeText(normalizedValue));
    if (!resolvedValue || seen.has(normalizeText(resolvedValue))) {
      return;
    }

    seen.add(normalizeText(resolvedValue));
    nextSelected.push(resolvedValue);
  });

  selectedGenres = new Set(nextSelected);
  syncGenreSelectionUI();
  return nextSelected.length > 0 ? 1 : 0;
}

function applyPresetPlatforms(values) {
  if (!Array.isArray(values) || values.length === 0) {
    selectedPlatforms = new Set();
    updatePlatformSummary();
    return 0;
  }

  const allowed = new Map(platformOptionValues.map((value) => [normalizeText(value), value]));
  const nextSelected = [];
  const seen = new Set();

  values.forEach((rawValue) => {
    const normalizedValue = String(rawValue || "").trim();
    if (normalizedValue === "") {
      return;
    }

    const resolvedValue = allowed.get(normalizeText(normalizedValue));
    if (!resolvedValue || seen.has(normalizeText(resolvedValue))) {
      return;
    }

    seen.add(normalizeText(resolvedValue));
    nextSelected.push(resolvedValue);
  });

  selectedPlatforms = new Set(nextSelected);
  syncPlatformSelectionUI();
  return nextSelected.length > 0 ? 1 : 0;
}

function getSelectedPlatformValues() {
  return platformOptionValues.filter((value) => selectedPlatforms.has(value));
}

function syncPlatformSelectionUI() {
  if (!platformPanel) {
    updatePlatformSummary();
    return;
  }

  const selected = selectedPlatforms;
  Array.from(platformPanel.querySelectorAll('input[type="checkbox"][data-platform-value]')).forEach((input) => {
    input.checked = selected.has(input.value);
  });

  updatePlatformSummary();
}

function updateSelectedPlatformsFromPanel() {
  if (!platformPanel) {
    selectedPlatforms = new Set();
    updatePlatformSummary();
    return;
  }

  const nextSelected = Array.from(platformPanel.querySelectorAll('input[type="checkbox"][data-platform-value]'))
    .filter((input) => input.checked)
    .map((input) => input.value);

  selectedPlatforms = new Set(nextSelected);
  updatePlatformSummary();
}

function updatePlatformSummary() {
  if (!platformSummaryEl) {
    return;
  }

  const values = getSelectedPlatformValues();
  if (values.length === 0) {
    platformSummaryEl.textContent = "All Platforms";
    return;
  }

  if (values.length === 1) {
    platformSummaryEl.textContent = values[0];
    return;
  }

  if (values.length === 2) {
    platformSummaryEl.textContent = values[0] + " + " + values[1];
    return;
  }

  platformSummaryEl.textContent = values.length + " Platforms selected";
}

function togglePlatformPanel() {
  if (!platformPanel || !platformToggle || !platformControl) {
    return;
  }

  const isOpen = !platformControl.classList.contains("is-open");
  if (isOpen) {
    openPlatformPanel();
  } else {
    closePlatformPanel();
  }
}

function openPlatformPanel() {
  if (!platformPanel || !platformToggle || !platformControl) {
    return;
  }

  platformPanel.hidden = false;
  platformControl.classList.add("is-open");
  platformToggle.setAttribute("aria-expanded", "true");
}

function closePlatformPanel() {
  if (!platformPanel || !platformToggle || !platformControl) {
    return;
  }

  platformPanel.hidden = true;
  platformControl.classList.remove("is-open");
  platformToggle.setAttribute("aria-expanded", "false");
}

function getSelectedGenreValues() {
  return genreOptionValues.filter((value) => selectedGenres.has(value));
}

function syncGenreSelectionUI() {
  if (!genrePanel) {
    updateGenreSummary();
    return;
  }

  const selected = selectedGenres;
  Array.from(genrePanel.querySelectorAll('input[type="checkbox"][data-genre-value]')).forEach((input) => {
    input.checked = selected.has(input.value);
  });

  updateGenreSummary();
}

function updateSelectedGenresFromPanel() {
  if (!genrePanel) {
    selectedGenres = new Set();
    updateGenreSummary();
    return;
  }

  const nextSelected = Array.from(genrePanel.querySelectorAll('input[type="checkbox"][data-genre-value]'))
    .filter((input) => input.checked)
    .map((input) => input.value);

  selectedGenres = new Set(nextSelected);
  updateGenreSummary();
}

function updateGenreSummary() {
  if (!genreSummaryEl) {
    return;
  }

  const values = getSelectedGenreValues();
  if (values.length === 0) {
    genreSummaryEl.textContent = "All Genres";
    return;
  }

  if (values.length === 1) {
    genreSummaryEl.textContent = values[0];
    return;
  }

  if (values.length === 2) {
    genreSummaryEl.textContent = values[0] + " + " + values[1];
    return;
  }

  genreSummaryEl.textContent = values.length + " Genres selected";
}

function toggleGenrePanel() {
  if (!genrePanel || !genreToggle || !genreControl) {
    return;
  }

  const isOpen = !genreControl.classList.contains("is-open");
  if (isOpen) {
    openGenrePanel();
  } else {
    closeGenrePanel();
  }
}

function openGenrePanel() {
  if (!genrePanel || !genreToggle || !genreControl) {
    return;
  }

  genrePanel.hidden = false;
  genreControl.classList.add("is-open");
  genreToggle.setAttribute("aria-expanded", "true");
}

function closeGenrePanel() {
  if (!genrePanel || !genreToggle || !genreControl) {
    return;
  }

  genrePanel.hidden = true;
  genreControl.classList.remove("is-open");
  genreToggle.setAttribute("aria-expanded", "false");
}

function getEffectiveRating(item) {
  const imdbRating = Number(item && item.imdbRating);
  if (Number.isFinite(imdbRating)) {
    return imdbRating;
  }

  const tmdbRating = Number(item && (item.rating ?? item.voteAverage ?? item.score));
  return Number.isFinite(tmdbRating) ? tmdbRating : NaN;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function canonicalPlatformName(rawName) {
  const value = String(rawName || "").trim();
  if (!value) {
    return "";
  }

  const normalized = normalizeText(value);
  if (normalized.includes("hbomax") || normalized === "max") {
    return "HBO Max";
  }

  return value;
}

function joinValues(item, keys, transform) {
  for (let index = 0; index < keys.length; index += 1) {
    const values = asArray(item[keys[index]]);
    if (values.length > 0) {
      const seen = new Set();
      const normalizedValues = [];

      values.forEach((value) => {
        const normalizedValue = typeof transform === "function" ? transform(value) : String(value);
        if (normalizedValue === null || normalizedValue === undefined || String(normalizedValue).trim() === "") {
          return;
        }

        const textValue = String(normalizedValue);
        if (seen.has(textValue)) {
          return;
        }

        seen.add(textValue);
        normalizedValues.push(textValue);
      });

      return normalizedValues.join(", ");
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

function getPlatformValues(item) {
  const values = [];
  const seen = new Set();

  asArray(item && (item.platforms || item.platform)).forEach((value) => {
    const label = canonicalPlatformName(value);
    if (!label) {
      return;
    }

    const key = normalizeText(label);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    values.push(label);
  });

  return values;
}

function formatPlatformDisplay(platforms, isExpanded) {
  const values = Array.isArray(platforms) ? platforms.filter((value) => String(value || "").trim() !== "") : [];
  if (values.length === 0) {
    return "Platform: Unknown platform";
  }

  return "Platform: " + values.join(", ");
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
