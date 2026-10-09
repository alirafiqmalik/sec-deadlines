"""Create one reviewable venue PR from a signed Cloudflare submission."""

import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

from venue_validation import InvalidSubmission, MARKER, append_venue, parse_submission, unique_object

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
DATA_PATH = "_data/conferences.yml"


class APIError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"GitHub API returned HTTP {status}.")


class GitHub:
    def __init__(self, repository, credential):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise InvalidSubmission("Invalid repository configuration.")
        self.repository = repository
        self.credential = credential

    def call(self, method, path, body=None):
        request = urllib.request.Request(
            "https://api.github.com/repos/" + self.repository + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={"Authorization": "Bearer " + self.credential, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sec-deadlines-submissions", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                content = response.read(1_000_001)
                if len(content) > 1_000_000:
                    raise InvalidSubmission("GitHub response is too large.")
                return json.loads(content) if content else None
        except urllib.error.HTTPError as error:
            raise APIError(error.code) from None

    def maybe(self, path):
        try:
            return self.call("GET", path)
        except APIError as error:
            if error.status == 404:
                return None
            raise

    def contents(self, path, ref):
        result = self.call("GET", "/contents/" + path + "?ref=" + urllib.parse.quote(ref, safe=""))
        if result.get("encoding") != "base64" or result.get("size", 0) > 500_000:
            raise InvalidSubmission("Venue data is too large or unsupported.")
        return base64.b64decode(result["content"]).decode("utf-8"), result["sha"]


def signed_envelope(raw, signature, secret, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if not isinstance(raw, str) or len(raw.encode()) > 7000 or not isinstance(signature, str) or not re.fullmatch(r"[0-9a-f]{64}", signature) or len(secret) < 32:
        raise InvalidSubmission("Missing or invalid submission signature.")
    expected = hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise InvalidSubmission("Submission signature does not match.")
    try:
        envelope = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(envelope, dict) or set(envelope) != {"version", "id", "day", "createdAt", "payload", "slot"} or type(envelope["version"]) is not int or envelope["version"] != 1:
            raise ValueError()
        created = dt.datetime.fromisoformat(envelope["createdAt"].replace("Z", "+00:00"))
        if not created.tzinfo or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", envelope["day"]) or envelope["day"] != created.astimezone(dt.timezone.utc).date().isoformat() or not -60 <= (now - created).total_seconds() <= 86400:
            raise ValueError()
        if not UUID.fullmatch(envelope["id"]) or type(envelope["slot"]) is not int or not 1 <= envelope["slot"] <= 5:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise InvalidSubmission("Submission metadata is invalid or expired.") from None
    body = MARKER + "\n```json\n" + json.dumps(envelope["payload"]) + "\n```"
    parse_submission(body, today=now.date())
    return envelope


def load_entries(content):
    entries = yaml.safe_load(content)
    if not isinstance(entries, list) or not all(isinstance(v, dict) and isinstance(v.get("name"), str) and type(v.get("year")) is int for v in entries):
        raise InvalidSubmission("Existing venue data has an unsupported format.")
    return entries


def reserve_git_slot(api, envelope, base_sha):
    """Immutable refs provide a second atomic daily cap, independent of the Worker."""
    ref = f"tags/venue-quota/{envelope['day']}/slot-{envelope['slot']}"
    proof = json.dumps(envelope, sort_keys=True, separators=(",", ":"))
    existing = api.maybe("/git/ref/" + ref)
    if existing:
        tag = api.call("GET", "/git/tags/" + existing["object"]["sha"])
        if tag.get("message") != proof:
            raise InvalidSubmission("This daily quota slot is already reserved for another submission.")
        return ref
    tag = api.call("POST", "/git/tags", {"tag": ref.removeprefix("tags/"), "message": proof, "object": base_sha, "type": "commit"})
    try:
        api.call("POST", "/git/refs", {"ref": "refs/" + ref, "sha": tag["sha"]})
    except APIError as error:
        if error.status not in (409, 422):
            raise
        existing = api.call("GET", "/git/ref/" + ref)
        current = api.call("GET", "/git/tags/" + existing["object"]["sha"])
        if current.get("message") != proof:
            raise InvalidSubmission("This daily quota slot was reserved by another submission.") from None
    return ref


def process(api, envelope, *, today=None):
    repo = api.call("GET", "")
    base_branch = repo["default_branch"]
    if base_branch != "master":
        raise InvalidSubmission("The submission workflow expects the master branch.")
    base = api.call("GET", "/git/ref/heads/" + base_branch)["object"]["sha"]
    branch = "venue-submissions/" + envelope["id"]
    owner = api.repository.split("/")[0]
    query = urllib.parse.urlencode({"head": owner + ":" + branch, "state": "all", "per_page": 10})
    existing_prs = api.call("GET", "/pulls?" + query)
    if existing_prs:
        return existing_prs[0]["html_url"]
    original, data_sha = api.contents(DATA_PATH, base)
    entries = load_entries(original)
    body = MARKER + "\n```json\n" + json.dumps(envelope["payload"]) + "\n```"
    payload = parse_submission(body, existing=entries, today=today)
    quota_ref = reserve_git_slot(api, envelope, base)
    existing_branch = api.maybe("/git/ref/heads/" + branch)
    if not existing_branch:
        api.call("POST", "/git/refs", {"ref": "refs/heads/" + branch, "sha": base})
        revised = append_venue(original, payload["venue"])
        # Parse the exact bytes before writing. Only one inert JSON/YAML record changes.
        if load_entries(revised) != entries + [payload["venue"]]:
            raise InvalidSubmission("Generated venue data did not round-trip.")
        api.call("PUT", "/contents/" + DATA_PATH, {"message": f"feat(data): add {payload['venue']['name']} {payload['venue']['year']}", "branch": branch, "sha": data_sha, "content": base64.b64encode(revised.encode()).decode()})
    else:
        # A retry must never turn an independently modified branch into a trusted PR.
        compare = api.call("GET", f"/compare/{base}...{existing_branch['object']['sha']}")
        if len(compare.get("files", [])) != 1 or compare["files"][0]["filename"] != DATA_PATH:
            raise InvalidSubmission("Existing submission branch has unexpected changes.")
        revised, _ = api.contents(DATA_PATH, existing_branch["object"]["sha"])
        if load_entries(revised) != entries + [payload["venue"]]:
            raise InvalidSubmission("Existing submission branch does not match its signed data.")
    venue = payload["venue"]
    proof = f"<!-- venue-submission:{envelope['day']}:{envelope['slot']}:{envelope['id']} -->"
    description = f"""Add **{venue['name']} {venue['year']}** from the website form.

Evidence supplied by the visitor: <{payload['source']}>

- Submission: `{envelope['id']}`
- Shared daily quota: slot {envelope['slot']} of 5 on {envelope['day']} (UTC).
- Bot verification passed. The visitor's identity is **not verified**.
- Schema, URL safety, duplicate, and injection checks passed.
- Only `{DATA_PATH}` changes. Existing entries stay unchanged.

Before merging, check the official call for papers, deadline, timezone, and venue scope. Bot verification does not establish legitimacy.

Quota evidence: `{quota_ref}`.
{proof}
"""
    pr = api.call("POST", "/pulls", {"title": f"Add venue: {venue['name']} {venue['year']}", "head": branch, "base": base_branch, "body": description, "maintainer_can_modify": True})
    head_sha = pr["head"]["sha"]
    api.call("POST", "/statuses/" + head_sha, {"state": "success", "context": "Venue data safety", "description": "Signed submission; one safe venue record; daily quota reserved."})
    return pr["html_url"]


def notify(envelope, status, pr_url=None):
    endpoint = os.environ.get("SUBMISSION_API_URL", "")
    if not re.fullmatch(r"https://sec-deadlines-submissions\.[a-z0-9-]+\.workers\.dev", endpoint):
        raise InvalidSubmission("Submission callback URL is not configured.")
    result = {"id": envelope["id"], "day": envelope["day"], "status": status, "prUrl": pr_url}
    raw = json.dumps(result, separators=(",", ":")).encode()
    signature = hmac.new(os.environ["SUBMISSION_SIGNING_KEY"].encode(), raw, hashlib.sha256).hexdigest()
    request = urllib.request.Request(endpoint + "/internal/result", data=raw, method="POST", headers={"Content-Type": "application/json", "X-Submission-Signature": signature})
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise InvalidSubmission("Submission callback failed.")


def main():
    envelope = None
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        inputs = event.get("inputs", {})
        envelope = signed_envelope(inputs.get("submission"), inputs.get("signature"), os.environ.get("SUBMISSION_SIGNING_KEY", ""))
        pr_url = process(GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"]), envelope)
        notify(envelope, "created", pr_url)
        print("Venue PR created:", pr_url)
    except Exception as error:
        # Never print HTTP bodies, untrusted data, or environment values.
        print(str(error) if isinstance(error, (InvalidSubmission, APIError)) else "Venue submission failed. Check service configuration.", file=sys.stderr)
        if envelope:
            try:
                notify(envelope, "failed")
            except Exception:
                print("Status notification failed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
