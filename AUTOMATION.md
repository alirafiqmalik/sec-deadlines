# Automation

## Auto-hide of past deadlines (client-side)

Past deadline cards are hidden by default.

`index.html` renders one card per deadline. `static/js/main.js` reads each
deadline and timezone, sorts the cards, and updates their status:

- Past deadline cards are hidden automatically by default.
- The **Show past deadlines** toggle in the filter bar reveals them.
- "Hide All Past Deadlines" turns off that toggle.
- "Delete Expired Venues" removes a venue from the current page only when
  all its deadlines have passed. A reload restores it.
- Venues with a `TBA` deadline show a `TBA` badge and stay visible.
- Cards are sorted by soonest upcoming deadline; a live countdown ticks
  every second and past cards are hidden when their deadlines pass.

## Auto-Find (GitHub Actions)

`.github/workflows/auto-find.yml` runs `scripts/auto_find.py` weekly
(Mondays 03:17 UTC) and on manual dispatch. It does two things:

1. **Auto-delete stale venues (server-side)** — entries whose deadlines all passed more
   than 90 days ago are removed from `_data/conferences.yml` and
   `_data/conferences_extra.yml` and committed directly to `master`.
2. **Discover new venues** — candidate conferences are pulled from public
   deadline trackers (sec-deadlines upstream, ai-deadlines). Entries not
   already tracked locally are appended to `_data/conferences_extra.yml`
   on an `auto-find/<date>` branch and proposed via pull request
   (max 20 per run) for manual review before merging.

Both steps use the built-in `GITHUB_TOKEN`; no extra secrets are required.

## Adding or updating a venue

Add a verified entry to `_data/conferences.yml`:

```yaml
- name: CCS
  description: ACM Conference on Computer and Communications Security
  year: 2027
  link: https://example.org/
  deadline: ['2027-01-14 23:59', '2027-04-29 23:59']  # multiple cycles ok
  timezone: Etc/GMT+12   # AoE; omit for the same default
  date: October 2027
  place: City, Country
  comment: optional note
  tags: [SEC, CONF]
```

Use `deadline: ['TBA']` until the organizer announces a date. The page and
calendar feeds render only `_data/conferences.yml`; auto-found candidates in
`_data/conferences_extra.yml` must be verified and moved there first.
