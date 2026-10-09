"""Validate public venue submissions without evaluating input or fetching URLs."""

import datetime as dt
import ipaddress
import json
import re
import unicodedata
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MARKER = "<!-- sec-deadlines-venue:v1 -->"
MAX_BYTES = 6000
DAILY_LIMIT = 5
FIELDS = {"name", "year", "description", "link", "dblp", "deadline", "timezone", "date", "place", "comment", "tags"}
REQUIRED = {"name", "year", "link", "deadline", "timezone", "date", "place", "tags"}
TOPICS = {"SEC", "CRYPTO", "PQC", "QUANTUM", "FORMAL", "AI"}
KINDS = {"CONF", "WORKSHOP", "TUTORIAL", "POSTER", "TOOLS"}
RANKS = {"TOP4", "CORE-A", "CORE-B", "CORE-C", "OTHERS"}


class InvalidSubmission(ValueError):
    pass


def text(value, field, maximum, minimum=1):
    if not isinstance(value, str) or not minimum <= len(value) <= maximum or value != value.strip():
        raise InvalidSubmission(f"{field}: enter {minimum}–{maximum} characters without surrounding spaces.")
    if any(unicodedata.category(c).startswith("C") for c in value) or any(s in value for s in ("<", ">", "{{", "{%", "}}", "%}")):
        raise InvalidSubmission(f"{field}: HTML, templates, and control characters are not allowed.")
    return value


def public_url(value, field):
    value = text(value, field, 400)
    decoded = value
    for _ in range(3):
        decoded = unquote(decoded)
        text(decoded, field, 400)
    if any(c.isspace() for c in decoded) or any(c in decoded for c in ('"', "'", "\\", "`")):
        raise InvalidSubmission(f"{field}: enter a plain HTTPS URL.")
    try:
        url = urlsplit(value)
        host = (url.hostname or "").lower()
        port = url.port
    except ValueError:
        raise InvalidSubmission(f"{field}: enter a valid HTTPS URL.") from None
    if url.scheme != "https" or url.username is not None or url.password is not None or port not in (None, 443):
        raise InvalidSubmission(f"{field}: HTTPS is required; credentials and custom ports are not allowed.")
    if not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", host):
        raise InvalidSubmission(f"{field}: use a public domain name, not an IP address.")
    if host.endswith((".localhost", ".local", ".internal", ".test", ".invalid", ".example", ".onion")):
        raise InvalidSubmission(f"{field}: local and reserved domains are not allowed.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return value
    raise InvalidSubmission(f"{field}: IP addresses are not allowed.")


def venue_key(venue):
    return (re.sub(r"[^a-z0-9]", "", venue["name"].lower()), venue["year"])


def validate_venue(venue, existing=(), *, today=None):
    today = today or dt.datetime.now(dt.timezone.utc).date()
    if not isinstance(venue, dict) or set(venue) - FIELDS or not REQUIRED <= set(venue):
        raise InvalidSubmission("Venue fields are missing or unsupported.")
    venue = dict(venue)
    name = text(venue["name"], "name", 80)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 &().+:/-]*", name):
        raise InvalidSubmission("name: use letters, digits, spaces, or & ( ) . + : / -.")
    if type(venue["year"]) is not int or not today.year <= venue["year"] <= today.year + 5:
        raise InvalidSubmission("year: use the current year or one of the next five years.")
    for field, maximum in (("description", 240), ("date", 100), ("place", 120), ("comment", 600)):
        if field in venue:
            text(venue[field], field, maximum)
    for field in ("link", "dblp"):
        if field in venue:
            public_url(venue[field], field)
    if "dblp" in venue and urlsplit(venue["dblp"]).hostname != "dblp.org":
        raise InvalidSubmission("dblp: use a URL on dblp.org.")
    timezone = text(venue["timezone"], "timezone", 64)
    if not re.fullmatch(r"[A-Za-z0-9_+/-]+", timezone) or ".." in timezone:
        raise InvalidSubmission("timezone: enter an IANA timezone.")
    try:
        ZoneInfo(timezone)
    except (ValueError, ZoneInfoNotFoundError):
        raise InvalidSubmission("timezone: enter a recognized IANA timezone.") from None
    deadlines = venue["deadline"]
    if not isinstance(deadlines, list) or not 1 <= len(deadlines) <= 8 or not all(isinstance(d, str) for d in deadlines):
        raise InvalidSubmission("deadline: enter one to eight dates, or TBA alone.")
    if len(set(deadlines)) != len(deadlines) or ("TBA" in deadlines and deadlines != ["TBA"]):
        raise InvalidSubmission("deadline: remove duplicates and use TBA alone.")
    for deadline in deadlines:
        if deadline == "TBA":
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", deadline):
            raise InvalidSubmission("deadline: use YYYY-MM-DD HH:mm.")
        try:
            parsed = dt.datetime.strptime(deadline, "%Y-%m-%d %H:%M")
        except ValueError:
            raise InvalidSubmission("deadline: enter a real calendar date and time.") from None
        if not venue["year"] - 2 <= parsed.year <= venue["year"]:
            raise InvalidSubmission("deadline: use a year within two years before the venue year.")
    tags = venue["tags"]
    if not isinstance(tags, list) or not 2 <= len(tags) <= 12 or not all(isinstance(t, str) for t in tags):
        raise InvalidSubmission("tags: select a research domain and publication type.")
    selected = set(tags)
    if len(selected) != len(tags) or selected - (TOPICS | KINDS | RANKS) or not selected & TOPICS or not selected & KINDS or len(selected & RANKS) > 1:
        raise InvalidSubmission("tags: use known, unique tags and at most one ranking.")
    if any(venue_key(entry) == venue_key(venue) for entry in existing):
        raise InvalidSubmission("This venue and year already exist. Submit an update through a manual PR.")
    return venue


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidSubmission("Duplicate JSON fields are not allowed.")
        result[key] = value
    return result


def parse_submission(body, existing=(), *, today=None):
    if not isinstance(body, str) or len(body.encode("utf-8")) > MAX_BYTES:
        raise InvalidSubmission("Submission is too large.")
    match = re.fullmatch(re.escape(MARKER) + r"\s*```json\n(.*?)\n```\s*", body, re.DOTALL)
    if not match:
        raise InvalidSubmission("Use the Add Venue form without changing the submission format.")
    try:
        payload = json.loads(match[1], object_pairs_hook=unique_object)
    except (ValueError, RecursionError):
        raise InvalidSubmission("Submission JSON is invalid or contains duplicate fields.") from None
    if not isinstance(payload, dict) or set(payload) != {"schemaVersion", "venue", "source"} or type(payload["schemaVersion"]) is not int or payload["schemaVersion"] != 1:
        raise InvalidSubmission("Unsupported submission format.")
    return {"schemaVersion": 1, "venue": validate_venue(payload["venue"], existing, today=today), "source": public_url(payload["source"], "source")}


def append_venue(original, venue):
    """JSON objects are valid YAML; preserve all existing bytes and comments."""
    return original + ("" if original.endswith("\n") else "\n") + "\n- " + json.dumps(venue, ensure_ascii=True, separators=(",", ":")) + "\n"
