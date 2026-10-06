#!/usr/bin/env python3
"""Auto-Find: discover new venue deadlines and prune stale venues.

Runs in GitHub Actions (see .github/workflows/auto-find.yml).

1. Prune: any venue whose deadlines have ALL passed more than
   PRUNE_AFTER_DAYS ago is auto-deleted from the data files and committed
   directly to the default branch.
2. Find: candidate venues are pulled from public deadline trackers. Venues
   not already tracked locally are appended to _data/conferences_extra.yml
   on a branch and proposed via pull request for review.
"""

import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA_FILES = [ROOT / "_data" / "conferences.yml", ROOT / "_data" / "conferences_extra.yml"]
EXTRA_FILE = ROOT / "_data" / "conferences_extra.yml"

PRUNE_AFTER_DAYS = 90
MAX_CANDIDATES_PER_RUN = 20

SOURCES = {
    "sec-deadlines upstream": "https://raw.githubusercontent.com/sec-deadlines/sec-deadlines/master/_data/conferences.yml",
    "ai-deadlines": "https://raw.githubusercontent.com/paperswithcode/ai-deadlines/gh-pages/_data/conferences.yml",
}

DL_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?")

FIELDS = ["name", "description", "year", "link", "deadline", "timezone", "date", "place", "note", "sub"]


def parse_deadlines(entry):
    d = entry.get("deadline")
    if not d:
        return []
    if isinstance(d, str):
        d = [d]
    out = []
    for x in d:
        m = DL_RE.search(str(x))
        if not m:
            continue
        h = int(m.group(4)) if m.group(4) else 23
        mi = int(m.group(5)) if m.group(5) else 59
        try:
            out.append(dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), h, mi))
        except ValueError:
            continue
    return out


def norm_key(entry):
    name = re.sub(r"[^a-z0-9]", "", str(entry.get("name", "")).lower())
    return (name, str(entry.get("year", "")))


def git(*args):
    subprocess.run(["git", *args], check=True, cwd=str(ROOT))


def load_file(f):
    if not f.exists():
        return []
    data = yaml.safe_load(f.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else []


def write_file(f, entries):
    header = ""
    if f.exists():
        for ln in f.read_text(encoding="utf-8").splitlines(keepends=True):
            if ln.startswith("#") or not ln.strip():
                header += ln
            else:
                break
    body = yaml.safe_dump(entries, allow_unicode=True, sort_keys=False)
    f.write_text(header + body, encoding="utf-8")


def prune_stale():
    cutoff = dt.datetime.utcnow() - dt.timedelta(days=PRUNE_AFTER_DAYS)
    pruned = 0
    for f in DATA_FILES:
        entries = load_file(f)
        if not entries:
            continue
        kept = []
        for e in entries:
            dls = parse_deadlines(e)
            if dls and max(dls) < cutoff:
                print(f"[prune] {e.get('name')} {e.get('year')} "
                      f"(last deadline {max(dls).date()})", flush=True)
                pruned += 1
                continue
            kept.append(e)
        if len(kept) != len(entries):
            write_file(f, kept)
    if pruned:
        git("config", "user.name", "github-actions[bot]")
        git("config", "user.email",
            "41898282+github-actions[bot]@users.noreply.github.com")
        git("add", "_data")
        git("commit", "-m",
            f"chore(data): prune venues with deadlines past {PRUNE_AFTER_DAYS} days")
        git("push")
        print(f"[prune] committed {pruned} removal(s)", flush=True)
    else:
        print("[prune] nothing to prune", flush=True)


def fetch_candidates():
    existing = {norm_key(e) for f in DATA_FILES for e in load_file(f)}
    now = dt.datetime.utcnow()
    candidates = []
    for label, url in SOURCES.items():
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            data = yaml.safe_load(r.text) or []
        except Exception as ex:  # noqa: BLE001 - one bad source must not abort the run
            print(f"[find] source '{label}' failed: {ex}", flush=True)
            continue
        for e in data:
            if not isinstance(e, dict):
                continue
            try:
                year = int(e.get("year") or 0)
            except (TypeError, ValueError):
                year = 0
            if year and year < now.year:
                continue
            dls = parse_deadlines(e)
            if dls and max(dls) < now:
                continue  # already passed; not worth proposing
            key = norm_key(e)
            if key in existing:
                continue
            existing.add(key)
            entry = {
                "name": e.get("name"),
                "description": e.get("description"),
                "year": year or None,
                "link": e.get("link"),
                "deadline": e.get("deadline"),
                "timezone": e.get("timezone") or "UTC-12",
                "date": e.get("date"),
                "place": e.get("place") or e.get("location"),
                "note": f"auto-found from {label}; please verify",
                "sub": e.get("sub") or ["TBD"],
            }
            candidates.append({k: v for k, v in entry.items() if v not in (None, "")})
            if len(candidates) >= MAX_CANDIDATES_PER_RUN:
                return candidates
    return candidates


def propose(candidates):
    stamp = dt.date.today().isoformat()
    branch = f"auto-find/{stamp}"
    git("config", "user.name", "github-actions[bot]")
    git("config", "user.email",
        "41898282+github-actions[bot]@users.noreply.github.com")
    git("checkout", "-b", branch)

    extra = load_file(EXTRA_FILE)
    extra.extend(candidates)
    write_file(EXTRA_FILE, extra)

    git("add", str(EXTRA_FILE.relative_to(ROOT)))
    git("commit", "-m", f"feat(data): auto-find {len(candidates)} candidate venue(s)")
    git("push", "-u", "origin", branch)

    lines = ["Auto-Find discovered venue(s) not tracked locally.", ""]
    for c in candidates:
        dl = c.get("deadline") or "TBA"
        lines.append(f"- **{c.get('name')} {c.get('year') or ''}** — deadline: {dl}")
    lines += ["", "Please verify dates, links, and tags before merging.",
              "Entries land in `_data/conferences_extra.yml`."]
    body = "\n".join(lines)

    res = subprocess.run(
        ["gh", "pr", "create", "--title",
         f"feat(data): auto-find candidate venues ({stamp})",
         "--body", body, "--head", branch],
        cwd=str(ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print(f"[find] gh pr create: {res.stderr.strip()}", flush=True)
    else:
        print(f"[find] PR opened: {res.stdout.strip()}", flush=True)


def main():
    prune_stale()
    candidates = fetch_candidates()
    print(f"[find] {len(candidates)} new candidate(s)", flush=True)
    if candidates:
        propose(candidates)


if __name__ == "__main__":
    sys.exit(main())
