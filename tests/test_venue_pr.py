import datetime as dt
import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from venue_pr import APIError, InvalidSubmission, process, reserve_git_slot, signed_envelope
from check_venue_pr import check_changes
from venue_validation import append_venue

SECRET = "unit-test-signing-value-do-not-use" * 2
NOW = dt.datetime(2026, 10, 9, 12, tzinfo=dt.timezone.utc)
ID = "2da86da5-942b-4360-9f12-4a65482c6e09"


def envelope():
    return {"version": 1, "id": ID, "day": "2026-10-09", "createdAt": "2026-10-09T12:00:00.000Z", "slot": 1, "payload": {"schemaVersion": 1, "source": "https://conference.org/cfp", "venue": {"name": "Example", "year": 2027, "link": "https://conference.org/", "deadline": ["TBA"], "timezone": "Etc/GMT+12", "date": "TBA", "place": "TBA", "tags": ["SEC", "CONF"]}}}


def signed(value):
    raw = json.dumps(value)
    return raw, hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()


class ProofAPI:
    repository = "owner/repo"

    def __init__(self, proof=None, collision=None, files=None, revised=None):
        self.proof = proof
        self.collision = collision
        self.writes = []
        self.files = files or [{"filename": "_data/conferences.yml", "status": "modified"}]
        self.original = "# Keep existing data\n- name: Existing\n  year: 2026\n"
        self.revised = revised or append_venue(self.original, envelope()["payload"]["venue"])

    def maybe(self, path):
        return {"object": {"sha": "tag"}} if self.proof is not None else None

    def call(self, method, path, body=None):
        if path.startswith("/compare/"):
            return {"files": self.files}
        if method == "GET" and path.startswith("/git/ref/"):
            return {"object": {"sha": "tag"}}
        if method == "GET" and path.startswith("/git/tags/"):
            return {"message": self.proof}
        if method == "POST" and path == "/git/tags":
            self.writes.append(body)
            return {"sha": "new-tag"}
        if method == "POST" and path == "/git/refs":
            if self.collision:
                self.proof = self.collision
                raise APIError(422)
            self.proof = self.writes[0]["message"]
            return {}
        raise AssertionError((method, path))

    def contents(self, path, ref):
        return (self.original if ref == "base" else self.revised), "sha"


class SignatureTests(unittest.TestCase):
    def test_valid_signature_and_reject_tampering(self):
        value = envelope()
        raw, signature = signed(value)
        self.assertEqual(signed_envelope(raw, signature, SECRET, NOW), value)
        with self.assertRaises(InvalidSubmission):
            signed_envelope(raw.replace('Example', 'Attacker'), signature, SECRET, NOW)
        with self.assertRaises(InvalidSubmission):
            signed_envelope(raw, '0' * 64, SECRET, NOW)

    def test_signed_but_invalid_input_and_expiry_are_rejected(self):
        for change in [{"slot": 6}, {"slot": True}, {"day": "2026-10-08"}, {"id": "../../etc/passwd"}, {"createdAt": "2026-10-07T12:00:00Z"}, {"createdAt": "2026-10-09T12:05:00Z"}]:
            value = envelope(); value.update(change)
            with self.subTest(change=change), self.assertRaises(InvalidSubmission):
                signed_envelope(*signed(value), SECRET, NOW)
        value = envelope(); value["payload"]["venue"]["name"] = "</script>"
        with self.assertRaises(InvalidSubmission):
            signed_envelope(*signed(value), SECRET, NOW)

    def test_atomic_slot_cannot_be_reused_by_another_payload_even_during_a_race(self):
        value = envelope()
        api = ProofAPI()
        self.assertEqual(reserve_git_slot(api, value, "base"), "tags/venue-quota/2026-10-09/slot-1")
        self.assertEqual(reserve_git_slot(api, value, "base"), "tags/venue-quota/2026-10-09/slot-1")
        other = envelope(); other["id"] = "1" + ID[1:]
        with self.assertRaises(InvalidSubmission):
            reserve_git_slot(api, other, "base")
        racing = ProofAPI(collision=json.dumps(other, sort_keys=True, separators=(",", ":")))
        with self.assertRaises(InvalidSubmission):
            reserve_git_slot(racing, value, "base")


class PRScopeTests(unittest.TestCase):
    def pr(self):
        return {"base": {"sha": "base"}, "head": {"sha": "head", "ref": "venue-submissions/" + ID, "repo": {"full_name": "owner/repo"}}, "body": f"<!-- venue-submission:2026-10-09:1:{ID} -->"}

    def test_review_report_requires_exact_record_and_immutable_proof(self):
        api = ProofAPI(proof=json.dumps(envelope()))
        self.assertIn("Quota proof matches", check_changes(api, self.pr(), today=NOW.date()))
        other = envelope(); other["payload"]["venue"]["link"] = "https://different.org"
        api.proof = json.dumps(other)
        with self.assertRaises(InvalidSubmission):
            check_changes(api, self.pr())

    def test_unrelated_code_or_workflow_changes_fail_for_automated_pr(self):
        for file in [".github/workflows/venue-submission.yml", "static/js/main.js", "scripts/venue_validation.py", ".gitmodules"]:
            api = ProofAPI(files=[{"filename": "_data/conferences.yml", "status": "modified"}, {"filename": file, "status": "added"}])
            with self.subTest(file=file), self.assertRaises(InvalidSubmission):
                check_changes(api, self.pr())

    def test_existing_record_edits_and_forged_proof_fail(self):
        api = ProofAPI(proof=json.dumps(envelope()))
        api.revised = api.revised.replace("Existing", "Altered")
        with self.assertRaises(InvalidSubmission):
            check_changes(api, self.pr())
        api = ProofAPI(proof=json.dumps(envelope()))
        pr = self.pr(); pr["body"] = "No proof"
        with self.assertRaises(InvalidSubmission):
            check_changes(api, pr)


class WorkflowTests(unittest.TestCase):
    def test_creates_only_a_data_branch_and_pr_and_retries_without_more_writes(self):
        import base64
        class API(ProofAPI):
            def __init__(self):
                super().__init__()
                self.created_pr = None
                self.mutations = []
            def maybe(self, path):
                if "/heads/" in path:
                    return None
                return super().maybe(path)
            def call(self, method, path, body=None):
                if method == "GET" and path == "":
                    return {"default_branch": "master"}
                if path == "/git/ref/heads/master":
                    return {"object": {"sha": "base"}}
                if path.startswith("/pulls?"):
                    return [self.created_pr] if self.created_pr else []
                if method == "POST" and path == "/git/refs" and body["ref"].startswith("refs/heads/"):
                    self.mutations.append((path, body)); return {}
                if method == "PUT" and path == "/contents/_data/conferences.yml":
                    self.mutations.append((path, body)); self.revised = base64.b64decode(body["content"]).decode(); return {}
                if method == "POST" and path == "/pulls":
                    self.mutations.append((path, body))
                    self.created_pr = {"html_url": "https://github.com/owner/repo/pull/1", "head": {"sha": "head"}}
                    return self.created_pr
                if path.startswith("/statuses/"):
                    self.mutations.append((path, body)); return {}
                return super().call(method, path, body)
        api = API()
        self.assertEqual(process(api, envelope(), today=NOW.date()), "https://github.com/owner/repo/pull/1")
        self.assertTrue(api.revised.startswith(api.original))
        changes = [body for path, body in api.mutations if path.startswith("/contents/")]
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["branch"], "venue-submissions/" + ID)
        self.assertEqual(api.mutations[-1][1]["context"], "Venue data safety")
        self.assertEqual(api.mutations[-1][1]["state"], "success")
        writes = len(api.mutations)
        self.assertEqual(process(api, envelope(), today=NOW.date()), "https://github.com/owner/repo/pull/1")
        self.assertEqual(len(api.mutations), writes)


if __name__ == "__main__":
    unittest.main()
