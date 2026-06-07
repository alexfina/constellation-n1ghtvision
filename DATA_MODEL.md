# Data Model

## Purpose

Define a simple local JSON structure for trusted recommendation data.

## Core Fields

Each item should represent one title candidate or one manually verified title.

- `id`
- `title`
- `type`
- `year`
- `regions`
- `platforms`
- `genres`
- `moodTags`
- `qualityTier`
- `rating`
- `shortBlurb`
- `availabilityStatus`
- `verified`
- `lastChecked`
- `source`

## Example Shape

Example:

```json
{
  "id": "arrival-2016",
  "title": "Arrival",
  "type": "movie",
  "year": 2016,
  "regions": ["AT"],
  "platforms": ["Netflix"],
  "genres": ["sci-fi", "drama"],
  "moodTags": ["thoughtful", "slow-burn", "serious"],
  "qualityTier": "high",
  "rating": 7.9,
  "shortBlurb": "A thoughtful sci-fi drama about language, time, and first contact.",
  "availabilityStatus": "needs manual verification",
  "verified": false,
  "lastChecked": null,
  "source": "AI-assisted candidate list"
}

## Data Rules

- Only manually verified titles become trusted app data
- External AI can help suggest candidates, but not auto-publish them into the app
- No live TMDB or other API integration for v1

