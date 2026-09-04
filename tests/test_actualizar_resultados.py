import json
import sys
import tempfile
import unittest
from copy import deepcopy
from datetime import date
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import actualizar_resultados as updater  # noqa: E402


def make_draw(contest: int, draw_date: str) -> dict:
    parsed_date = date.fromisoformat(draw_date)
    return {
        "concurso": contest,
        "fecha": draw_date,
        "dia": updater.DAY_NAMES[parsed_date.weekday()],
        "url": (
            "https://www.quini-6-resultados.com.ar/quini6/"
            f"sorteo-{contest}-del-dia-{parsed_date:%d-%m-%Y}.htm"
        ),
        "tradicional": [1, 2, 3, 4, 5, 6],
        "segunda": [7, 8, 9, 10, 11, 12],
        "revancha": [13, 14, 15, 16, 17, 18],
        "siempre_sale": [19, 20, 21, 22, 23, 24],
    }


def make_data(draws: list[dict] | None = None) -> dict:
    return {
        "actualizado_en_utc": "2026-06-07T12:00:00+00:00",
        "mis_numeros": [1, 8, 17, 21, 31, 33],
        "precio_boleta": 3000,
        "boletas_por_sorteo": 3,
        "precios_por_periodo": [
            {"desde": "2026-01-01", "precio_boleta": 3000}
        ],
        "integrantes": 3,
        "sorteos": draws or [make_draw(3380, "2026-06-07")],
    }


class FakeResponse:
    def __init__(self, content: str):
        self.content = content.encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.content


class ParserTests(unittest.TestCase):
    def test_fetch_draw_parses_all_sections(self):
        html = """
        <html><head><style>oculto</style></head><body>
        <h1>Sorteo Nro. 3380</h1>
        <h2>SORTEO TRADICIONAL</h2><p>01 - 02 - 03 - 04 - 05 - 06</p>
        <h2>LA SEGUNDA DEL QUINI</h2><p>07 - 08 - 09 - 10 - 11 - 12</p>
        <h2>SORTEO REVANCHA</h2><p>13 - 14 - 15 - 16 - 17 - 18</p>
        <h2>QUINI QUE SIEMPRE SALE</h2><p>19 - 20 - 21 - 22 - 23 - 24</p>
        <script>ignorar()</script>
        </body></html>
        """
        with patch.object(updater, "urlopen", return_value=FakeResponse(html)):
            draw = updater.fetch_draw(3380, date(2026, 6, 7))

        self.assertEqual(draw, make_draw(3380, "2026-06-07"))

    def test_numbers_after_heading_requires_six_numbers(self):
        with self.assertRaisesRegex(ValueError, "seis números"):
            updater.numbers_after_heading(
                "SORTEO TRADICIONAL\n01 - 02 - 03", "SORTEO TRADICIONAL"
            )


class ValidationTests(unittest.TestCase):
    def test_repository_data_is_valid(self):
        data = json.loads((ROOT / "data.json").read_text(encoding="utf-8"))
        updater.validate_data(data)

    def test_duplicate_draw_number_is_rejected(self):
        data = make_data()
        data["sorteos"][0]["tradicional"][-1] = 1
        with self.assertRaisesRegex(ValueError, "repetidos"):
            updater.validate_data(data)

    def test_duplicate_contest_is_rejected(self):
        draw = make_draw(3380, "2026-06-07")
        data = make_data([draw, make_draw(3380, "2026-06-03")])
        with self.assertRaisesRegex(ValueError, "Concurso repetido"):
            updater.validate_data(data)


class UpdateTests(unittest.TestCase):
    def test_next_draw_day(self):
        self.assertEqual(
            updater.next_draw_day(date(2026, 6, 7)),
            date(2026, 6, 10),
        )
        self.assertEqual(
            updater.next_draw_day(date(2026, 6, 10)),
            date(2026, 6, 14),
        )

    def test_finds_postponed_draw_on_actual_date(self):
        data = make_data([make_draw(3390, "2026-07-12")])
        calls = []

        def fetcher(contest, draw_date):
            calls.append((contest, draw_date))
            if contest == 3391 and draw_date == date(2026, 7, 16):
                return make_draw(contest, draw_date.isoformat())
            return None

        updated, added, refreshed, changed = updater.update_draws(
            data,
            today=date(2026, 7, 16),
            fetcher=fetcher,
            output=lambda message: None,
        )

        self.assertEqual(
            calls,
            [(3391, date(2026, 7, 15)), (3391, date(2026, 7, 16))],
        )
        self.assertEqual((added, refreshed, changed), (1, 0, True))
        self.assertEqual(updated["sorteos"][0]["fecha"], "2026-07-16")

    def test_adds_available_draw_and_stops_at_first_missing_one(self):
        available = {3381: make_draw(3381, "2026-06-10")}
        calls = []

        def fetcher(contest, draw_date):
            calls.append((contest, draw_date))
            return available.get(contest)

        updated, added, refreshed, changed = updater.update_draws(
            make_data(),
            today=date(2026, 6, 14),
            fetcher=fetcher,
            output=lambda message: None,
        )

        self.assertEqual(calls, [(3381, date(2026, 6, 10)), (3382, date(2026, 6, 14))])
        self.assertEqual((added, refreshed, changed), (1, 0, True))
        self.assertEqual(updated["sorteos"][0]["concurso"], 3381)

    def test_unchanged_refresh_does_not_request_a_write(self):
        data = make_data()
        original = deepcopy(data["sorteos"][0])

        updated, added, refreshed, changed = updater.update_draws(
            data,
            refresh_from=3380,
            today=date(2026, 6, 7),
            fetcher=lambda contest, draw_date: deepcopy(original),
            output=lambda message: None,
        )

        self.assertEqual((added, refreshed, changed), (0, 1, False))
        self.assertEqual(updated, data)

    def test_atomic_write_leaves_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.json"
            path.write_text("{}\n", encoding="utf-8")
            updater.write_json_atomic(path, make_data())
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), make_data())
    def test_atomic_write_preserves_crlf(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.json"
            path.write_bytes(b"{}\r\n")
            updater.write_json_atomic(path, make_data())
            content = path.read_bytes()
            self.assertNotIn(b"\n", content.replace(b"\r\n", b""))



if __name__ == "__main__":
    unittest.main()
