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

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if "id" in attributes:
            self.ids.append(attributes["id"])
        if tag == "script" and attributes.get("src"):
            self.scripts.append(attributes["src"])
            self.local_assets.append(attributes["src"])
        if tag == "link" and attributes.get("href", "").startswith(("./", "/")):
            self.local_assets.append(attributes["href"])


class FrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.javascript = (ROOT / "marea-app.js").read_text(encoding="utf-8")
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

    def test_active_javascript_is_external(self):
        self.assertEqual(self.document.scripts, ["marea-app.js"])
        self.assertNotRegex(self.html, r"<script>\s*\S")

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


if __name__ == "__main__":
    unittest.main()
