#!/usr/bin/env python3
"""Load vitals and cycle data into chart's Turso database.

Source files live in Data/ (gitignored). Every command previews what it found; nothing is
written until you pass --commit.

  # Apple Health: iPhone Health app > profile > Export All Health Data > export.zip
  scripts/chart_import.py apple-health Data/mia/export.zip --person mia [--since 2025-01-01]

  # Values pulled from a PDF, written as a JSON manifest (format in the repo README)
  scripts/chart_import.py manifest Data/extracted/*.json

  # 23andMe or AncestryDNA raw data. Only findings are stored; the raw file stays local.
  scripts/chart_import.py genetics Data/mia/genome.txt --person mia

Each person's data is visible only to the account with the same username.

Target database: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment, or --prod to use
the `chart` database via the turso CLI. Manifest PDFs upload to gs://$GCS_BUCKET/docs/<person>/
(default bucket chart-jkomg-docs) with the gcloud CLI.
"""

import argparse
import csv
import gzip
import re
import shutil
import json
import os
import subprocess
import sys
import zipfile
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from xml.etree.ElementTree import iterparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import libsql  # noqa: E402

import clinical  # noqa: E402
import genetics  # noqa: E402
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
    genetics.init_schema(conn)
    clinical.init_schema(conn)
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
    """Import one or more extraction manifests (scripts/EXTRACTION.md)."""
    repo = Path(__file__).resolve().parent.parent
    manifests = []
    for name in args.files:
        path = Path(name)
        data = json.loads(path.read_text())
        person = data["person"].lower()
        if not re.fullmatch(r"[a-z0-9_-]+", person):
            sys.exit(f"{path.name}: bad person {person!r}")
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*\.pdf", data["document"]):
            sys.exit(f"{path.name}: document must be a lowercase bucket filename ending in .pdf, got {data['document']!r}")
        for m in data.get("measurements", []):
            if m["metric"] not in vitals.METRICS:
                sys.exit(f"{path.name}: unknown metric {m['metric']!r}. Known: {', '.join(vitals.METRICS)}")
        source = repo / data["source_path"] if data.get("source_path") else None
        if source and not source.exists():
            sys.exit(f"{path.name}: source_path not found: {source}")
        manifests.append((path, person, data, source))

    counts = defaultdict(int)
    for path, person, data, _ in manifests:
        n = {k: len(data.get(k, [])) for k in ("labs", "measurements", "events", "diagnoses", "medications", "genetic_findings", "cycles")}
        for k, v in n.items():
            counts[k] += v
        detail = " ".join(f"{k}={v}" for k, v in n.items() if v)
        print(f"  {data.get('date') or '????-??-??'}  {person:<6} {data['document']:<58} {data.get('kind', ''):<8} {detail}")
    print(f"\n{len(manifests)} documents · " + " · ".join(f"{v} {k}" for k, v in counts.items() if v))
    if not args.commit:
        print("\nPreview only. Re-run with --commit to write.")
        return

    conn, url = connect(args.prod)
    bucket = os.environ.get("GCS_BUCKET", "chart-jkomg-docs")
    for path, person, data, source in manifests:
        doc = data["document"]
        if source and args.local_docs:
            target = Path(args.local_docs) / person / doc
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        elif source and not args.no_upload:
            subprocess.run(["gcloud", "storage", "cp", "--quiet", str(source), f"gs://{bucket}/docs/{person}/{doc}"], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        clinical.replace_document(conn, person, data)
        conn.execute("DELETE FROM measurements WHERE person = ? AND doc = ?", (person, doc))
        vitals.upsert_measurements(conn, ((person, m["metric"], m["taken_at"], float(m["value"]), "pdf", doc, m.get("page"), m.get("note"), seq)
                                          for m, seq in with_seq(data.get("measurements", []))))
        vitals.upsert_cycles(conn, ((person, c["start"], c.get("end"), "pdf", doc, c.get("page"), c.get("note"))
                                    for c in data.get("cycles", [])))
        print(f"  imported {doc}")
    print(f"\nWrote {len(manifests)} documents to {url}")


def with_seq(measurements):
    """Number repeat readings of a metric on the same date (0, 1, 2...) so none overwrite another.
    Systolic and diastolic are listed in pairs, so the nth of each lines up."""
    seen = defaultdict(int)
    for m in measurements:
        key = (m["metric"], m["taken_at"])
        yield m, seen[key]
        seen[key] += 1


CLINVAR_URL = "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/tab_delimited/variant_summary.txt.gz"


def read_raw_genotypes(path: Path):
    """23andMe (rsid, chrom, pos, genotype) or AncestryDNA (rsid, chrom, pos, allele1, allele2)."""
    provider, build, genotypes = "Consumer DNA test", None, {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("#"):
                if "23andMe" in line:
                    provider = "23andMe"
                elif "AncestryDNA" in line:
                    provider = "AncestryDNA"
                if m := re.search(r"build (\d+)|GRCh(\d+)", line, re.I):
                    build = f"GRCh{m.group(1) or m.group(2)}"
                continue
            parts = line.split()
            if len(parts) < 4 or not parts[0].startswith("rs"):
                continue
            gt = parts[3] + parts[4] if len(parts) >= 5 else parts[3]
            if "0" in gt or "-" in gt:
                continue  # no call
            genotypes[parts[0]] = gt.upper()
    return provider, build or "GRCh37", genotypes


def clinvar_findings(genotypes: dict[str, str], clinvar: Path):
    rows = {}
    with gzip.open(clinvar, "rt", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f, delimiter="\t")
        sig_col = next(c for c in ("ClinicalSignificance", "GermlineClassification", "Germline classification") if c in reader.fieldnames)
        for row in reader:
            rs = row.get("RS# (dbSNP)", "-1")
            if rs == "-1" or f"rs{rs}" not in genotypes or row.get("Assembly") != "GRCh37":
                continue
            if row.get("Type") != "single nucleotide variant" or row[sig_col].lower() not in genetics.PATHOGENIC:
                continue
            stars = genetics.REVIEW_STARS.get(row.get("ReviewStatus", ""), 0)
            alt = row.get("AlternateAlleleVCF") or row.get("AlternateAllele", "")
            gt = genotypes[f"rs{rs}"]
            if stars < 1 or len(alt) != 1 or alt not in gt:
                continue
            change = re.search(r"\(p\.[^)]+\)", row["Name"]) or re.search(r"c\.[^ ]+", row["Name"])
            label = f"{row['GeneSymbol'].split(';')[0]} {change.group(0).strip('()') if change else row['Name']}"
            conditions = [c for c in row.get("PhenotypeList", "").split("|") if c and c.lower() not in ("not provided", "not specified")]
            key = (f"rs{rs}", label)
            if key not in rows or stars > rows[key]["review_stars"]:
                rows[key] = {"category": "clinvar", "gene": row["GeneSymbol"].split(";")[0], "label": label, "rsid": f"rs{rs}",
                             "genotype": gt, "result": genetics.describe(gt.count(alt)), "detected": 1,
                             "classification": row[sig_col], "condition": "; ".join(conditions[:3]) or None,
                             "review_stars": stars, "note": None}
    return list(rows.values())


def cmd_genetics(args):
    path = Path(args.file)
    provider, build, genotypes = read_raw_genotypes(path)
    if build != "GRCh37":
        sys.exit(f"{path.name} is on {build}; matching expects GRCh37 (what 23andMe and AncestryDNA use).")
    clinvar = Path(args.clinvar)
    if not clinvar.exists():
        print(f"Downloading ClinVar ({CLINVAR_URL}) to {clinvar} ...")
        clinvar.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl", "-fL", "--progress-bar", "-o", str(clinvar), CLINVAR_URL], check=True)
    release = datetime.fromtimestamp(clinvar.stat().st_mtime).date().isoformat()

    rows = genetics.panel_findings(genotypes) + genetics.pgx_findings(genotypes) + clinvar_findings(genotypes, clinvar)
    print(f"{path.name}: {provider}, {build}, {len(genotypes):,} markers → {args.person}  (ClinVar downloaded {release})")
    for category, title in (("panel", "Common variants"), ("pgx", "Medication-related"), ("clinvar", "ClinVar pathogenic / likely pathogenic (unconfirmed)")):
        group = [r for r in rows if r["category"] == category]
        print(f"\n  {title}: {len(group)}")
        for r in group:
            print(f"    {r['label']:<28} {r.get('genotype') or '--':<14} {r['result']}"
                  + (f"  [{r['review_stars']}★ {r['condition'] or ''}]" if category == "clinvar" else ""))
    if not args.commit:
        print("\nPreview only. Re-run with --commit to write.")
        return
    conn, url = connect(args.prod)
    source = {"provider": provider, "filename": path.name, "build": build, "markers": len(genotypes), "clinvar_release": release}
    genetics.replace_findings(conn, args.person, source, rows)
    print(f"\nWrote {len(rows)} findings to {url}")


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

    manifest = sub.add_parser("manifest", parents=[common], help="import extraction manifests (scripts/EXTRACTION.md)")
    manifest.add_argument("files", nargs="+")
    manifest.add_argument("--no-upload", action="store_true", help="don't upload the PDF to the bucket")
    manifest.add_argument("--local-docs", help="copy PDFs here (<dir>/<person>/) instead of the bucket, for CHART_LOCAL_DOCS_DIR")
    manifest.set_defaults(func=cmd_manifest)

    genes = sub.add_parser("genetics", parents=[common], help="import 23andMe / AncestryDNA raw data (findings only)")
    genes.add_argument("file")
    genes.add_argument("--person", required=True)
    genes.add_argument("--clinvar", default="Data/clinvar/variant_summary.txt.gz", help="ClinVar variant_summary (downloaded if missing)")
    genes.set_defaults(func=cmd_genetics)

    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9_-]+", getattr(args, "person", "x")):
        sys.exit("--person must be the account username, e.g. mia")
    args.func(args)


if __name__ == "__main__":
    main()
