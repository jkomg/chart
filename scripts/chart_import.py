#!/usr/bin/env python3
"""Load vitals and cycle data into chart's Turso database.

Source files live in Data/ (gitignored). Every command previews what it found; nothing is
written until you pass --commit.

  # Apple Health: iPhone Health app > profile > Export All Health Data > export.zip
  scripts/chart_import.py apple-health Data/mia/export.zip --person mia [--since 2025-01-01]

  # Values pulled from a PDF, written as a JSON manifest (see Data/README in the repo README)
  scripts/chart_import.py manifest Data/extracted/2025-03-12_physical.json

Target database: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment, or --prod to use
the `chart` database via the turso CLI. Manifest PDFs upload to gs://$GCS_BUCKET (default
chart-jkomg-docs) with the gcloud CLI.
"""

import argparse
import json
import os
import subprocess
import sys
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path
from xml.etree.ElementTree import iterparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import libsql  # noqa: E402

import vitals  # noqa: E402

APPLE_QUANTITIES = {
    # HealthKit type -> (metric, how to combine several readings in one day)
    "HKQuantityTypeIdentifierBodyMass": ("weight", "last"),
    "HKQuantityTypeIdentifierRestingHeartRate": ("resting_hr", "mean"),
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": ("hrv_sdnn", "mean"),
    "HKQuantityTypeIdentifierBloodPressureSystolic": ("bp_systolic", "mean"),
    "HKQuantityTypeIdentifierBloodPressureDiastolic": ("bp_diastolic", "mean"),
    "HKQuantityTypeIdentifierOxygenSaturation": ("spo2", "mean"),
    "HKQuantityTypeIdentifierRespiratoryRate": ("respiratory_rate", "mean"),
    "HKQuantityTypeIdentifierBodyTemperature": ("body_temp", "mean"),
    "HKQuantityTypeIdentifierVO2Max": ("vo2max", "last"),
}
MENSTRUAL_FLOW = "HKCategoryTypeIdentifierMenstrualFlow"
PERIOD_GAP_DAYS = 2  # unlogged days inside a period that still count as the same period


def to_canonical(metric: str, value: float, unit: str) -> float:
    if metric == "weight" and unit == "kg":
        return value * 2.20462
    if metric == "spo2" and value <= 1:
        return value * 100
    if metric == "body_temp" and unit == "degC":
        return value * 9 / 5 + 32
    return value


def parse_apple_health(path: Path, since: str | None):
    if path.suffix == ".zip":
        archive = zipfile.ZipFile(path)
        name = next(n for n in archive.namelist() if n.endswith("/export.xml") or n == "export.xml")
        stream = archive.open(name)
    else:
        stream = open(path, "rb")

    daily: dict[tuple[str, str], list[float]] = defaultdict(list)
    combine: dict[str, str] = {}
    flow_days: set[str] = set()
    with stream:
        for _, elem in iterparse(stream, events=("end",)):
            if elem.tag != "Record":
                continue
            kind = elem.get("type")
            day = (elem.get("startDate") or "")[:10]  # export timestamps are already in local time
            if since and day < since:
                elem.clear()
                continue
            if kind in APPLE_QUANTITIES:
                metric, how = APPLE_QUANTITIES[kind]
                try:
                    value = to_canonical(metric, float(elem.get("value")), elem.get("unit", ""))
                except (TypeError, ValueError):
                    elem.clear()
                    continue
                daily[(metric, day)].append(value)
                combine[metric] = how
            elif kind == MENSTRUAL_FLOW and not (elem.get("value") or "").endswith("None"):
                flow_days.add(day)
            elem.clear()

    readings = []
    for (metric, day), values in sorted(daily.items()):
        value = values[-1] if combine[metric] == "last" else sum(values) / len(values)
        readings.append((metric, day, round(value, 3)))
    return readings, flow_days_to_periods(flow_days)


def flow_days_to_periods(days: set[str]) -> list[tuple[str, str]]:
    periods: list[list[date]] = []
    for day in sorted(date.fromisoformat(d) for d in days):
        if periods and (day - periods[-1][1]).days <= PERIOD_GAP_DAYS + 1:
            periods[-1][1] = day
        else:
            periods.append([day, day])
    return [(start.isoformat(), end.isoformat()) for start, end in periods]


def connect(prod: bool):
    url, token = os.environ.get("TURSO_DATABASE_URL"), os.environ.get("TURSO_AUTH_TOKEN")
    if prod:
        url = subprocess.check_output(["turso", "db", "show", "chart", "--url"], text=True).strip()
        token = subprocess.check_output(["turso", "db", "tokens", "create", "chart", "--expiration", "1d"], text=True).strip()
    if not url:
        sys.exit("Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN), or pass --prod.")
    conn = libsql.connect(database=url, auth_token=token or "")
    vitals.init_schema(conn)
    return conn, url


def summarize(readings, periods):
    by_metric = defaultdict(list)
    for metric, day, value in readings:
        by_metric[metric].append((day, value))
    unit = lambda m: vitals.METRICS[m]["unit"]  # noqa: E731
    for metric, points in sorted(by_metric.items()):
        values = [v for _, v in points]
        print(f"  {metric:<17} {len(points):>5} days  {points[0][0]} → {points[-1][0]}  "
              f"range {min(values):.1f}–{max(values):.1f} {unit(metric)}")
    if periods:
        print(f"  {'periods':<17} {len(periods):>5}       {periods[0][0]} → {periods[-1][0]}")


def cmd_apple_health(args):
    readings, periods = parse_apple_health(Path(args.file), args.since)
    print(f"Apple Health export for {args.person}:")
    summarize(readings, periods)
    if not args.commit:
        print("\nPreview only. Re-run with --commit to write.")
        return
    conn, url = connect(args.prod)
    vitals.upsert_measurements(conn, ((args.person, m, d, v, "apple_health", None, None, None) for m, d, v in readings))
    vitals.upsert_cycles(conn, ((args.person, s, e, "apple_health", None, None, None) for s, e in periods))
    print(f"\nWrote {len(readings)} readings and {len(periods)} periods to {url}")


def cmd_manifest(args):
    path = Path(args.file)
    data = json.loads(path.read_text())
    person, doc = data["person"].lower(), data.get("document")
    readings = []
    for m in data.get("measurements", []):
        if m["metric"] not in vitals.METRICS:
            sys.exit(f"Unknown metric {m['metric']!r}. Known: {', '.join(vitals.METRICS)}")
        readings.append((m["metric"], m["taken_at"], float(m["value"]), m.get("page"), m.get("note")))
    periods = [(c["start"], c.get("end"), c.get("page"), c.get("note")) for c in data.get("cycles", [])]
    print(f"{path.name} → {person}, source {doc or '(no PDF)'}:")
    for metric, day, value, page, _ in readings:
        print(f"  {day}  {vitals.METRICS[metric]['label']:<32} {value:g} {vitals.METRICS[metric]['unit']}  (p.{page or '?'})")
    for start, end, page, _ in periods:
        print(f"  period {start} → {end or '?'}  (p.{page or '?'})")
    if not args.commit:
        print("\nPreview only. Re-run with --commit to write.")
        return
    if doc and not args.no_upload:
        pdf = (path.parent / doc) if (path.parent / doc).exists() else Path("Data") / doc
        bucket = os.environ.get("GCS_BUCKET", "chart-jkomg-docs")
        subprocess.run(["gcloud", "storage", "cp", str(pdf), f"gs://{bucket}/docs/{doc}"], check=True)
    conn, url = connect(args.prod)
    vitals.upsert_measurements(conn, ((person, m, d, v, "pdf", doc, p, n) for m, d, v, p, n in readings))
    vitals.upsert_cycles(conn, ((person, s, e, "pdf", doc, p, n) for s, e, p, n in periods))
    print(f"\nWrote {len(readings)} readings and {len(periods)} periods to {url}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--commit", action="store_true", help="write to the database (default: preview)")
    common.add_argument("--prod", action="store_true", help="target the production Turso db via the turso CLI")

    apple = sub.add_parser("apple-health", parents=[common], help="import an Apple Health export.zip or export.xml")
    apple.add_argument("file")
    apple.add_argument("--person", required=True)
    apple.add_argument("--since", help="skip readings before this date (YYYY-MM-DD)")
    apple.set_defaults(func=cmd_apple_health)

    manifest = sub.add_parser("manifest", parents=[common], help="import values extracted from a PDF")
    manifest.add_argument("file")
    manifest.add_argument("--no-upload", action="store_true", help="don't upload the PDF to the bucket")
    manifest.set_defaults(func=cmd_manifest)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
