#!/usr/bin/env python3
"""Valida y actualiza data.json con los sorteos publicados de Quini 6."""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from argparse import ArgumentParser
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Callable
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
DAY_NAMES = {
    0: "lunes",
    1: "martes",
    2: "miércoles",
    3: "jueves",
    4: "viernes",
    5: "sábado",
    6: "domingo",
}
DRAW_WEEKDAYS = {2, 6}
MAX_DATE_SHIFT_DAYS = 6
NUMBER_MIN = 0
NUMBER_MAX = 45


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
    heading_match = re.search(
        rf"(?m)^\s*{re.escape(normalize(heading))}\s*$",
        normalized,
    )
    if not heading_match:
        raise ValueError(f"No se encontró la sección {heading!r}")
    fragment = normalized[heading_match.end() :]
    match = re.search(
        r"(?m)^\s*(\d{2})\s*-\s*(\d{2})\s*-\s*(\d{2})\s*-\s*"
        r"(\d{2})\s*-\s*(\d{2})\s*-\s*(\d{2})\s*$",
        fragment,
    )
    if not match:
        raise ValueError(f"No se encontraron seis números después de {heading!r}")
    return [int(value) for value in match.groups()]


def _iso_date(value: object, field: str) -> date:
    if not isinstance(value, str):
        raise ValueError(f"{field} debe ser una fecha ISO")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{field} no es una fecha ISO válida: {value!r}") from error


def _positive_number(value: object, field: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f"{field} debe ser un número mayor que cero")


def validate_draw(draw: object, context: str = "sorteo") -> None:
    """Valida la estructura y los valores de un sorteo."""
    if not isinstance(draw, dict):
        raise ValueError(f"{context} debe ser un objeto")

    contest = draw.get("concurso")
    if isinstance(contest, bool) or not isinstance(contest, int) or contest <= 0:
        raise ValueError(f"{context}.concurso debe ser un entero positivo")

    draw_date = _iso_date(draw.get("fecha"), f"{context}.fecha")
    expected_day = DAY_NAMES[draw_date.weekday()]
    if draw.get("dia") != expected_day:
        raise ValueError(f"{context}.dia no coincide con la fecha")

    url = draw.get("url")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise ValueError(f"{context}.url debe ser una URL HTTPS")

    for section in SECTIONS:
        values = draw.get(section)
        if not isinstance(values, list) or len(values) != 6:
            raise ValueError(f"{context}.{section} debe contener seis números")
        if any(
            isinstance(value, bool)
            or not isinstance(value, int)
            or not NUMBER_MIN <= value <= NUMBER_MAX
            for value in values
        ):
            raise ValueError(
                f"{context}.{section} sólo puede contener enteros entre "
                f"{NUMBER_MIN} y {NUMBER_MAX}"
            )
        if len(set(values)) != len(values):
            raise ValueError(f"{context}.{section} contiene números repetidos")


def validate_data(data: object) -> None:
    """Valida el archivo completo antes de usarlo o reemplazarlo."""
    if not isinstance(data, dict):
        raise ValueError("data.json debe contener un objeto")

    numbers = data.get("mis_numeros")
    if not isinstance(numbers, list) or len(numbers) != 6:
        raise ValueError("mis_numeros debe contener seis números")
    if any(
        isinstance(value, bool)
        or not isinstance(value, int)
        or not NUMBER_MIN <= value <= NUMBER_MAX
        for value in numbers
    ) or len(set(numbers)) != 6:
        raise ValueError("mis_numeros debe contener seis enteros únicos entre 0 y 45")

    _positive_number(data.get("precio_boleta"), "precio_boleta")
    _positive_number(data.get("boletas_por_sorteo"), "boletas_por_sorteo")

    members = data.get("integrantes")
    if isinstance(members, bool) or not isinstance(members, int) or members <= 0:
        raise ValueError("integrantes debe ser un entero positivo")

    periods = data.get("precios_por_periodo", [])
    if not isinstance(periods, list):
        raise ValueError("precios_por_periodo debe ser una lista")
    period_dates: set[date] = set()
    for index, period in enumerate(periods):
        if not isinstance(period, dict):
            raise ValueError(f"precios_por_periodo[{index}] debe ser un objeto")
        start = _iso_date(period.get("desde"), f"precios_por_periodo[{index}].desde")
        if start in period_dates:
            raise ValueError("precios_por_periodo contiene fechas repetidas")
        period_dates.add(start)
        _positive_number(
            period.get("precio_boleta"),
            f"precios_por_periodo[{index}].precio_boleta",
        )

    draws = data.get("sorteos")
    if not isinstance(draws, list) or not draws:
        raise ValueError("data.json debe contener al menos un sorteo")

    contests: set[int] = set()
    dates: set[str] = set()
    for index, draw in enumerate(draws):
        context = f"sorteos[{index}]"
        validate_draw(draw, context)
        contest = draw["concurso"]
        draw_date = draw["fecha"]
        if contest in contests:
            raise ValueError(f"Concurso repetido: {contest}")
        if draw_date in dates:
            raise ValueError(f"Fecha de sorteo repetida: {draw_date}")
        contests.add(contest)
        dates.add(draw_date)

    expected_order = sorted(
        draws,
        key=lambda draw: (draw["fecha"], draw["concurso"]),
        reverse=True,
    )
    if draws != expected_order:
        raise ValueError("Los sorteos deben estar ordenados del más nuevo al más antiguo")


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
        "dia": DAY_NAMES[draw_date.weekday()],
        "url": url,
    }
    for key, heading in SECTIONS.items():
        result[key] = numbers_after_heading(text, heading)
    validate_draw(result, f"concurso {concurso}")
    return result


def next_draw_day(value: date) -> date:
    current = value + timedelta(days=1)
    while current.weekday() not in DRAW_WEEKDAYS:
        current += timedelta(days=1)
    return current


def update_draws(
    data: dict,
    refresh_from: int | None = None,
    today: date | None = None,
    fetcher: Callable[[int, date], dict | None] = fetch_draw,
    output: Callable[[str], None] = print,
) -> tuple[dict, int, int, bool]:
    """Devuelve los datos actualizados sin escribirlos en disco."""
    validate_data(data)
    updated = deepcopy(data)
    original_draws = deepcopy(updated["sorteos"])
    by_contest = {int(draw["concurso"]): draw for draw in updated["sorteos"]}
    refreshed = 0

    if refresh_from is not None:
        refresh = sorted(
            (
                (contest, date.fromisoformat(draw["fecha"]))
                for contest, draw in by_contest.items()
                if contest >= refresh_from
            ),
            key=lambda item: item[0],
        )
        for contest, draw_date in refresh:
            draw = fetcher(contest, draw_date)
            if draw is None:
                raise ValueError(f"No se encontró el concurso publicado {contest}")
            validate_draw(draw, f"concurso {contest}")
            if draw["concurso"] != contest or draw["fecha"] != draw_date.isoformat():
                raise ValueError(
                    f"La fuente devolvió datos inesperados para el concurso {contest}"
                )
            by_contest[contest] = draw
            refreshed += 1
            output(f"Validado concurso {contest} del {draw_date.isoformat()}")

    last_contest = max(by_contest)
    last_date = date.fromisoformat(by_contest[last_contest]["fecha"])
    contest = last_contest + 1
    draw_date = next_draw_day(last_date)
    limit = today or date.today()
    added = 0

    while draw_date <= limit:
        actual_date = None
        draw = None
        max_shift = min(MAX_DATE_SHIFT_DAYS, (limit - draw_date).days)
        for offset in range(max_shift + 1):
            candidate_date = draw_date + timedelta(days=offset)
            draw = fetcher(contest, candidate_date)
            if draw is not None:
                actual_date = candidate_date
                break

        if draw is None or actual_date is None:
            output(f"El concurso {contest} todavía no está publicado.")
            break
        validate_draw(draw, f"concurso {contest}")
        if (
            draw["concurso"] != contest
            or draw["fecha"] != actual_date.isoformat()
        ):
            raise ValueError(
                f"La fuente devolvió datos inesperados para el concurso {contest}"
            )
        by_contest[contest] = draw
        output(f"Agregado concurso {contest} del {actual_date.isoformat()}")
        added += 1
        contest += 1
        draw_date = next_draw_day(actual_date)

    updated["sorteos"] = sorted(
        by_contest.values(),
        key=lambda draw: (draw["fecha"], draw["concurso"]),
        reverse=True,
    )
    validate_data(updated)
    changed = updated["sorteos"] != original_draws
    return updated, added, refreshed, changed


def write_json_atomic(path: Path, data: dict) -> None:
    """Reemplaza el JSON sólo después de haber escrito el contenido completo."""
    original = path.read_bytes()
    line_ending = "\r\n" if b"\r\n" in original else "\n"
    serialized = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    content = serialized.replace("\n", line_ending)
    temporary_path: Path | None = None
    try:
        with NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary_path = Path(temporary.name)
        temporary_path.chmod(path.stat().st_mode & 0o777)
        temporary_path.replace(path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> int:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh-from",
        type=int,
        help="Vuelve a descargar y validar desde este número de concurso.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Valida data.json sin consultar la red ni modificar archivos.",
    )
    parser.add_argument(
        "--data-path",
        type=Path,
        default=DATA_PATH,
        help="Ruta del JSON (por defecto: data.json en la raíz del proyecto).",
    )
    args = parser.parse_args()

    try:
        data = json.loads(args.data_path.read_text(encoding="utf-8"))
        validate_data(data)
        if args.check:
            print(f"{args.data_path} es válido ({len(data['sorteos'])} sorteos).")
            return 0

        updated, added, refreshed, changed = update_draws(
            data,
            refresh_from=args.refresh_from,
        )
        if changed:
            updated["actualizado_en_utc"] = datetime.now(timezone.utc).isoformat()
            write_json_atomic(args.data_path, updated)
            print(
                f"Actualización terminada: {added} sorteos nuevos, "
                f"{refreshed} validados."
            )
        else:
            print(
                f"Sin cambios: {added} sorteos nuevos, "
                f"{refreshed} validados."
            )
        return 0
    except (
        HTTPError,
        URLError,
        TimeoutError,
        OSError,
        json.JSONDecodeError,
        ValueError,
    ) as error:
        print(f"No se pudo actualizar {args.data_path}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
