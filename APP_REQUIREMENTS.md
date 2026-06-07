# Constellation v0.1 Requirements

## Goal

Build the smallest useful frontend version of Constellation.

The v0.1 app must work entirely in the browser and must not depend on AI calls, external APIs, or a backend.

## Core User Flow

1. Load recommendation data from projects/constellation/data/recommendations.json.
2. Let the user choose:
   - region
   - platform
   - genre
3. Filter the dataset using the selection.
4. Randomly display 1 to 3 matching recommendation cards.
5. Show a friendly empty-state message when no matching recommendations exist.

## Filtering Rules

Only include a recommendation when all of the following are true:

- verified === true
- availabilityStatus === "verified"
- the selected region exists in regions
- the selected platform exists in platforms
- the selected genre exists in genres

After filtering:

- shuffle the matching results
- return up to 3 results

## v0.1 Scope

Include:

- data loading from the local JSON file
- region, platform, and genre selectors
- verified-only filtering
- randomized recommendation display
- empty-state feedback
- basic readable card presentation

Exclude for now:

- AI-generated recommendations
- external APIs
- backend services
- user accounts
- persistence beyond the current session
- ranking, scoring, or personalization logic

## UX Requirements

- The interface should make the selection flow obvious.
- The results area should update when the selection changes.
- The empty state should explain that no verified matches were found and suggest changing filters.
- Recommendation cards should show the minimum useful title and metadata needed to understand why the item matched.

## Data Requirements

- The app should treat projects/constellation/data/recommendations.json as the source of truth.
- The frontend should tolerate empty or partially missing results by falling back to the empty state.
- The filtering logic should be deterministic apart from the intentional shuffle step.

## Acceptance Criteria

- The app runs locally without any backend process.
- The app reads the local recommendations JSON file.
- The app filters by region, platform, and genre.
- The app includes only verified recommendations with verified availability.
- The app displays 1 to 3 shuffled matches when available.
- The app shows a friendly empty state when no matches exist.
- The app does not make AI or network API calls.

## Implementation Notes

- Keep the first version simple and explicit.
- Prefer a small amount of clear filtering logic over abstractions.
- Preserve room for later expansion into ranking, explanation generation, or richer browsing once v0.1 is stable.
