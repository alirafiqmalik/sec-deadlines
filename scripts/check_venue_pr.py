"""Check PR data through GitHub APIs; never fetch or execute PR code."""

import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

from venue_pr import DATA_PATH, GitHub, InvalidSubmission, load_entries
from venue_validation import validate_venue


def check_changes(api, pr, today=None):
    base, head = pr["base"]["sha"], pr["head"]["sha"]
    compare = api.call("GET", f"/compare/{base}...{head}")
    files = compare.get("files", [])
    if len(files) >= 300:
        raise InvalidSubmission("PR is too large for a complete venue safety check.")
    automated = pr["head"]["ref"].startswith("venue-submissions/")
    changed_data = [f for f in files if f["filename"] == DATA_PATH]
    if automated and (len(files) != 1 or len(changed_data) != 1 or changed_data[0]["status"] != "modified"):
        raise InvalidSubmission("Automated venue PRs must modify only the conference data file.")
    if not changed_data:
        return "No venue data changed. Review code changes separately."
    original, _ = api.contents(DATA_PATH, base)
    revised, _ = api.contents(DATA_PATH, head)
    before, after = load_entries(original), load_entries(revised)
    if automated:
        if not revised.startswith(original) or after[:-1] != before or len(after) != len(before) + 1:
            raise InvalidSubmission("Automated venue PR must append exactly one venue without changing existing bytes.")
        validate_venue(after[-1], existing=before, today=today)
        match = re.search(r"<!-- venue-submission:(\d{4}-\d{2}-\d{2}):([1-5]):([0-9a-f-]{36}) -->", pr.get("body") or "")
        if not match or pr["head"]["ref"] != "venue-submissions/" + match[3] or pr["head"]["repo"]["full_name"] != api.repository:
            raise InvalidSubmission("Submission branch or quota proof is missing or mismatched.")
        ref = api.call("GET", f"/git/ref/tags/venue-quota/{match[1]}/slot-{match[2]}")
        tag = api.call("GET", "/git/tags/" + ref["object"]["sha"])
        envelope = json.loads(tag["message"])
        if envelope["id"] != match[3] or envelope["day"] != match[1] or envelope["slot"] != int(match[2]) or envelope["payload"]["venue"] != after[-1]:
            raise InvalidSubmission("Venue record differs from its immutable submission proof.")
        return f"One venue appended. Quota proof matches. Evidence: {envelope['payload']['source']}. Visitor identity is unverified. Review the official call for papers before merging."
    changes = [v for v in after if v not in before]
    for venue in changes:
        validate_venue(venue, today=today)
    return f"Checked {len(changes)} added or changed venue records. Review deletions and code changes separately."


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pr = event["pull_request"]
    api = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    try:
        result = check_changes(api, pr)
        state = "success"
        description = "Venue schema, injection checks, and submission scope passed."
    except Exception as error:
        result = str(error) if isinstance(error, InvalidSubmission) else "Venue validation failed. Inspect the diff and service logs."
        state, description = "failure", "Venue data or submission proof failed safety checks."
    # Only fixed text and HTML-escaped values enter the review report.
    import html
    summary = f"## Venue data safety\n\n{html.escape(result)}\n\nThis check runs trusted base-branch code. It never executes code from this PR.\n"
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        Path(os.environ["GITHUB_STEP_SUMMARY"]).write_text(summary)
    api.call("POST", "/statuses/" + pr["head"]["sha"], {"state": state, "context": "Venue data safety", "description": description})
    print(description)
    return 0 if state == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
