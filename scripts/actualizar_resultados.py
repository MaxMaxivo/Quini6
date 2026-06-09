#!/usr/bin/env python3
"""Actualiza data.json con los sorteos publicados de Quini 6."""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data.json"
BASE_URL = (
    "https://www.quini-6-resultados.com.ar/quini6/"
    "sorteo-{concurso}-del-dia-{fecha}.htm"
)
USER_AGENT = "Mozilla/5.0 (compatible; MareaQuini6/1.0)"

SECTIONS = {
    "tradicional": "SORTEO TRADICIONAL",
    "segunda": "LA SEGUNDA DEL QUINI",
    "revancha": "SORTEO REVANCHA",
    "siempre_sale": "QUINI QUE SIEMPRE SALE",
}


def strip_html(raw: str) -> str:
    raw = re.sub(r"<script\b[^>]*>.*?</script>", " ", raw, flags=re.I | re.S)
    raw = re.sub(r"<style\b[^>]*>.*?</style>", " ", raw, flags=re.I | re.S)
    raw = re.sub(r"<[^>]+>", "\n", raw)
    return "\n".join(line.strip() for line in raw.splitlines() if line.strip())


def normalize(value: str) -> str:
    return "".join(
        char
        for char in unicodedata.normalize("NFD", value.upper())
        if unicodedata.category(char) != "Mn"
    )


def numbers_after_heading(text: str, heading: str) -> list[int]:
    normalized = normalize(text)
    start = normalized.find(normalize(heading))
    if start < 0:
        raise ValueError(f"No se encontró la sección {heading!r}")
    fragment = normalized[start + len(heading) :]
    match = re.search(
        r"(?m)^\s*(\d{2})\s*-\s*(\d{2})\s*-\s*(\d{2})\s*-\s*"
        r"(\d{2})\s*-\s*(\d{2})\s*-\s*(\d{2})\s*$",
        fragment,
    )
    if not match:
        raise ValueError(f"No se encontraron seis números después de {heading!r}")
    return [int(value) for value in match.groups()]


def fetch_draw(concurso: int, draw_date: date) -> dict | None:
    url = BASE_URL.format(
        concurso=concurso,
        fecha=draw_date.strftime("%d-%m-%Y"),
    )
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=25) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except HTTPError as error:
        if error.code == 404:
            return None
        raise

    text = strip_html(raw)
    if not re.search(rf"Sorteo\s+Nro\.?\s*{concurso}\b", text, flags=re.I):
        return None

    result = {
        "concurso": concurso,
        "fecha": draw_date.isoformat(),
        "dia": "miércoles" if draw_date.weekday() == 2 else "domingo",
        "url": url,
    }
    for key, heading in SECTIONS.items():
        result[key] = numbers_after_heading(text, heading)
    return result


def next_draw_day(value: date) -> date:
    current = value + timedelta(days=1)
    while current.weekday() not in (2, 6):
        current += timedelta(days=1)
    return current


def main() -> int:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    draws = data.setdefault("sorteos", [])
    if not draws:
        print("data.json no contiene un sorteo inicial", file=sys.stderr)
        return 1

    by_contest = {int(draw["concurso"]): draw for draw in draws}
    last_contest = max(by_contest)
    last_date = date.fromisoformat(by_contest[last_contest]["fecha"])
    contest = last_contest + 1
    draw_date = next_draw_day(last_date)
    today = date.today()
    added = 0

    while draw_date <= today:
        try:
            draw = fetch_draw(contest, draw_date)
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            print(f"No se pudo leer el concurso {contest}: {error}", file=sys.stderr)
            return 1
        if draw is None:
            print(f"El concurso {contest} todavía no está publicado.")
            break
        by_contest[contest] = draw
        print(f"Agregado concurso {contest} del {draw_date.isoformat()}")
        added += 1
        contest += 1
        draw_date = next_draw_day(draw_date)

    data["sorteos"] = sorted(
        by_contest.values(),
        key=lambda draw: draw["fecha"],
        reverse=True,
    )
    data["actualizado_en_utc"] = datetime.now(timezone.utc).isoformat()
    DATA_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Actualización terminada: {added} sorteos nuevos.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
