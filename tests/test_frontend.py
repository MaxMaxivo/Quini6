from html.parser import HTMLParser
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DocumentParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.local_assets = []
        self.scripts = []
        self.start_tags = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        self.start_tags.append((tag, attributes))
        if "id" in attributes:
            self.ids.append(attributes["id"])
        if tag == "script" and attributes.get("src"):
            source = attributes["src"]
            self.scripts.append(source)
            if not source.startswith(("https://", "http://", "//")):
                self.local_assets.append(source)
        if tag == "link":
            href = attributes.get("href", "")
            if href and not href.startswith(("https://", "http://", "//")):
                self.local_assets.append(href)


class FrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.javascript = "\n".join(
            (ROOT / filename).read_text(encoding="utf-8")
            for filename in ("marea-app.js", "online-store.js", "state-utils.js")
        )
        cls.document = DocumentParser()
        cls.document.feed(cls.html)

    def test_document_ids_are_unique(self):
        self.assertEqual(
            len(self.document.ids),
            len(set(self.document.ids)),
            "index.html contiene ids repetidos",
        )

    def test_local_assets_exist(self):
        for asset in self.document.local_assets:
            with self.subTest(asset=asset):
                self.assertTrue((ROOT / asset.lstrip("/")).is_file())

    def test_scripts_are_ordered_and_javascript_is_external(self):
        self.assertEqual(
            self.document.scripts,
            [
                "app-config.js",
                (
                    "https://cdn.jsdelivr.net/npm/@supabase/"
                    "supabase-js@2.112.4/dist/umd/supabase.min.js"
                ),
                "state-utils.js",
                "online-store.js",
                "marea-app.js",
            ],
        )
        self.assertNotRegex(self.html, r"<script(?![^>]*\bsrc=)[^>]*>\s*\S")

    def test_javascript_only_uses_existing_static_ids(self):
        referenced_ids = set(
            re.findall(r'getElementById\("([^"]+)"\)', self.javascript)
        )
        dynamic_ids = {"cost-"}
        static_references = {
            value for value in referenced_ids
            if not any(value.startswith(prefix) for prefix in dynamic_ids)
        }
        self.assertLessEqual(static_references, set(self.document.ids))

    def test_no_inline_event_handlers_or_styles(self):
        for tag, attributes in self.document.start_tags:
            with self.subTest(tag=tag):
                self.assertNotIn("style", attributes)
                self.assertFalse(any(name.startswith("on") for name in attributes))
        self.assertNotIn("<style", self.html)

    def test_security_and_accessibility_basics_are_present(self):
        self.assertIn("Content-Security-Policy", self.html)
        self.assertIn('integrity="sha384-', self.html)
        self.assertIn("aria-live=\"polite\"", self.html)
        self.assertIn('class="skip-link"', self.html)
        self.assertIn('autocomplete="email"', self.html)
        self.assertIn("<dialog", self.html)

    def test_public_config_is_valid_and_non_secret(self):
        config = (ROOT / "app-config.js").read_text(encoding="utf-8")
        url = re.search(r'supabaseUrl:\s*"([^"]+)"', config)
        key = re.search(r'supabasePublishableKey:\s*"([^"]+)"', config)
        self.assertIsNotNone(url)
        self.assertIsNotNone(key)
        self.assertIsNotNone(re.fullmatch(r"https://[a-z0-9-]+[.]supabase[.]co", url.group(1)))
        self.assertIsNotNone(re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", key.group(1)))
        self.assertNotRegex(key.group(1), r"^(?:sb_secret_|service_role)")

    def test_supabase_schema_has_public_read_only_access(self):
        schema = (ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8")
        self.assertIn("enable row level security", schema)
        self.assertIn("force row level security", schema)
        self.assertIn("revoke all on table public.user_states from anon", schema)
        self.assertIn("grant select on table public.user_states to anon", schema)
        self.assertIn("to anon, authenticated\nusing (is_public)", schema)
        self.assertIn("user_states_one_public_idx", schema)
        self.assertGreaterEqual(schema.count("(select auth.uid()) = user_id"), 3)
        self.assertIn("public = excluded.public", schema)
        self.assertIn("  true,", schema)
        self.assertIn("(storage.foldername(name))[1]", schema)


if __name__ == "__main__":
    unittest.main()
