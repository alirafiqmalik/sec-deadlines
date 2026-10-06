# Automation

## Auto-hide of past deadlines (client-side)

`_layouts/home.html` tags every venue card with its deadline(s) and timezone.
On page load, JavaScript computes the next upcoming deadline per venue:

- Venues whose deadlines have **all passed** are hidden automatically.
- The **show past deadlines** toggle in the filter bar reveals them.
- Venues with no parseable deadline show a `TBA` badge and stay visible.
- Cards are sorted by soonest upcoming deadline; a live countdown ticks
  every second and re-hides a venue the moment its last deadline passes.

## Auto-Find (GitHub Actions)

`.github/workflows/auto-find.yml` runs `scripts/auto_find.py` weekly
(Mondays 03:17 UTC) and on manual dispatch. It does two things:

1. **Auto-delete stale venues** — entries whose deadlines all passed more
   than 90 days ago are removed from `_data/conferences.yml` and
   `_data/conferences_extra.yml` and committed directly to `master`.
2. **Discover new venues** — candidate conferences are pulled from public
   deadline trackers (sec-deadlines upstream, ai-deadlines). Entries not
   already tracked locally are appended to `_data/conferences_extra.yml`
   on an `auto-find/<date>` branch and proposed via pull request
   (max 20 per run) for manual review before merging.

Both steps use the built-in `GITHUB_TOKEN`; no extra secrets are required.

## Adding or updating a venue

Add an entry to `_data/conferences_extra.yml` (or edit
`_data/conferences.yml`):

```yaml
- name: CCS
  description: ACM Conference on Computer and Communications Security
  year: 2027
  link: https://example.org/
  deadline: ['2027-01-14 23:59', '2027-04-29 23:59']  # multiple cycles ok
  timezone: UTC-12        # AoE; or UTC+2, UTC-5, ...
  date: October 2027
  place: City, Country
  note: optional note
  sub: [SEC]
```

Leave `deadline:` empty for TBA. The site merges both data files at build
time; no layout changes are needed.
