"""Consumer DNA data (23andMe / AncestryDNA raw files), reduced to findings worth showing.

The raw file never leaves Data/. Import stores three kinds of rows in `genetic_findings`:
  clinvar - genotype contains an allele ClinVar classifies as pathogenic / likely pathogenic
  panel   - a fixed set of common, well-studied variants, reported whether or not detected
  pgx     - medication-related genes, summarized as a metabolizer / function status
Consumer arrays are unreliable for rare variants, so the UI marks clinvar rows as unconfirmed.
"""

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS genetic_findings (
        id INTEGER PRIMARY KEY,
        person TEXT NOT NULL,
        category TEXT NOT NULL,          -- clinvar | panel | pgx
        gene TEXT,
        label TEXT NOT NULL,             -- variant or test name shown to people
        rsid TEXT NOT NULL,              -- one or more rsIDs, comma-separated
        genotype TEXT,                   -- as reported by the array, e.g. "CT"; null if not tested
        result TEXT NOT NULL,            -- plain-language result
        detected INTEGER NOT NULL,       -- 1 if a variant of interest is present
        classification TEXT,             -- ClinVar classification
        condition TEXT,
        review_stars INTEGER,            -- ClinVar review status, 0-4
        note TEXT,
        source_file TEXT NOT NULL,
        UNIQUE (person, category, rsid, label)
    )""",
    """CREATE TABLE IF NOT EXISTS genetic_sources (
        id INTEGER PRIMARY KEY,
        person TEXT NOT NULL,
        provider TEXT NOT NULL,
        filename TEXT NOT NULL,
        build TEXT,
        markers INTEGER,
        clinvar_release TEXT,
        imported_at TEXT DEFAULT (datetime('now')),
        UNIQUE (person, filename)
    )""",
]

# Common variants clinicians ask about. Alleles are on the GRCh37 plus strand, as 23andMe and
# AncestryDNA report them. `risk` is the allele of interest.
PANEL = [
    {"gene": "F5", "label": "Factor V Leiden", "rsid": "rs6025", "risk": "T", "condition": "Inherited clotting risk (thrombophilia)"},
    {"gene": "F2", "label": "Prothrombin G20210A", "rsid": "rs1799963", "risk": "A", "condition": "Inherited clotting risk (thrombophilia)"},
    {"gene": "HFE", "label": "HFE C282Y", "rsid": "rs1800562", "risk": "A", "condition": "Hereditary hemochromatosis (iron overload)"},
    {"gene": "HFE", "label": "HFE H63D", "rsid": "rs1799945", "risk": "G", "condition": "Hereditary hemochromatosis (iron overload), milder"},
    {"gene": "MTHFR", "label": "MTHFR C677T", "rsid": "rs1801133", "risk": "A", "condition": "Folate metabolism",
     "note": "Very common. Professional guidelines (ACMG) advise against using it to guide care."},
]

CYP2C19 = {"rs4244285": ("A", "*2"), "rs4986893": ("A", "*3"), "rs12248560": ("T", "*17")}
CYP2C9 = {"rs1799853": ("T", "*2", 0.5), "rs1057910": ("C", "*3", 0.0)}

REVIEW_STARS = {
    "practice guideline": 4,
    "reviewed by expert panel": 3,
    "criteria provided, multiple submitters, no conflicts": 2,
    "criteria provided, single submitter": 1,
    "criteria provided, conflicting classifications": 1,
    "criteria provided, conflicting interpretations": 1,
}
PATHOGENIC = {"pathogenic", "likely pathogenic", "pathogenic/likely pathogenic"}


def init_schema(conn):
    for statement in SCHEMA:
        conn.execute(statement)
    conn.commit()


def copies(genotype: str | None, allele: str) -> int | None:
    if not genotype or "-" in genotype or genotype in ("DD", "II", "DI", "ID"):
        return None
    return genotype.count(allele)


def describe(n: int) -> str:
    return {0: "Not detected", 1: "1 copy (heterozygous)", 2: "2 copies (homozygous)"}[n]


def panel_findings(genotypes: dict[str, str]) -> list[dict]:
    rows = []
    for item in PANEL:
        gt = genotypes.get(item["rsid"])
        n = copies(gt, item["risk"])
        rows.append({"category": "panel", "gene": item["gene"], "label": item["label"], "rsid": item["rsid"], "genotype": gt,
                     "result": "Not tested on this chip" if n is None else describe(n), "detected": int(bool(n)),
                     "condition": item["condition"], "note": item.get("note")})

    # APOE: two markers combine into ε2/ε3/ε4. rs429358 C marks ε4; rs7412 T marks ε2.
    a, b = genotypes.get("rs429358"), genotypes.get("rs7412")
    e4, e2 = copies(a, "C"), copies(b, "T")
    if e4 is None or e2 is None or e4 + e2 > 2:
        result, detected = "Not tested on this chip", 0
    else:
        alleles = ["ε4"] * e4 + ["ε2"] * e2 + ["ε3"] * (2 - e4 - e2)
        order = {"ε2": 0, "ε3": 1, "ε4": 2}
        result, detected = "/".join(sorted(alleles, key=order.get)), int(e4 > 0)
    rows.append({"category": "panel", "gene": "APOE", "label": "APOE type", "rsid": "rs429358,rs7412",
                 "genotype": f"{a or '--'} / {b or '--'}", "result": result, "detected": detected,
                 "condition": "Alzheimer’s and cardiovascular risk (ε4 raises risk)", "note": None})
    return rows


def pgx_findings(genotypes: dict[str, str]) -> list[dict]:
    rows = []

    # CYP2C19 (clopidogrel, many SSRIs, PPIs). CPIC phenotypes from the star alleles found.
    found, tested = [], True
    for rsid, (allele, star) in CYP2C19.items():
        n = copies(genotypes.get(rsid), allele)
        if n is None:
            tested = False
            continue
        found += [star] * n
    if not tested:
        result, detected = "Not tested on this chip", 0
    else:
        stars = (found + ["*1", "*1"])[:2]
        loss = sum(s in ("*2", "*3") for s in stars)
        gain = stars.count("*17")
        phenotype = ("Poor metabolizer" if loss == 2 else "Intermediate metabolizer" if loss == 1 else
                     "Ultrarapid metabolizer" if gain == 2 else "Rapid metabolizer" if gain == 1 else "Normal metabolizer")
        result, detected = f"{phenotype} ({'/'.join(sorted(stars))})", int(phenotype != "Normal metabolizer")
    rows.append({"category": "pgx", "gene": "CYP2C19", "label": "CYP2C19", "rsid": ",".join(CYP2C19),
                 "genotype": " / ".join(genotypes.get(r) or "--" for r in CYP2C19), "result": result, "detected": detected,
                 "condition": "Clopidogrel, many antidepressants (SSRIs), proton-pump inhibitors", "note": None})

    # CYP2C9 (warfarin, NSAIDs, phenytoin). CPIC activity score: *1 = 1, *2 = 0.5, *3 = 0.
    score, tested, stars = 2.0, True, []
    for rsid, (allele, star, value) in CYP2C9.items():
        n = copies(genotypes.get(rsid), allele)
        if n is None:
            tested = False
            continue
        score -= n * (1 - value)
        stars += [star] * n
    if not tested:
        result, detected = "Not tested on this chip", 0
    else:
        phenotype = "Normal metabolizer" if score >= 2 else "Intermediate metabolizer" if score >= 1 else "Poor metabolizer"
        result, detected = f"{phenotype} ({'/'.join(sorted((stars + ['*1', '*1'])[:2]))})", int(score < 2)
    rows.append({"category": "pgx", "gene": "CYP2C9", "label": "CYP2C9", "rsid": ",".join(CYP2C9),
                 "genotype": " / ".join(genotypes.get(r) or "--" for r in CYP2C9), "result": result, "detected": detected,
                 "condition": "Warfarin, NSAIDs, phenytoin", "note": None})

    for gene, rsid, allele, condition, results in [
        ("VKORC1", "rs9923231", "T", "Warfarin dose sensitivity",
         ["Typical warfarin sensitivity", "Increased warfarin sensitivity", "Highly increased warfarin sensitivity"]),
        ("SLCO1B1", "rs4149056", "C", "Statin muscle side effects (especially simvastatin)",
         ["Normal function", "Decreased function", "Poor function"]),
    ]:
        gt = genotypes.get(rsid)
        n = copies(gt, allele)
        rows.append({"category": "pgx", "gene": gene, "label": gene, "rsid": rsid, "genotype": gt,
                     "result": "Not tested on this chip" if n is None else results[n], "detected": int(bool(n)),
                     "condition": condition, "note": None})
    return rows


def load_genetics(conn, person: str) -> dict:
    cols = ["category", "gene", "label", "rsid", "genotype", "result", "detected", "classification", "condition", "review_stars", "note", "source_file"]
    findings = [dict(zip(cols, row)) for row in conn.execute(
        f"SELECT {', '.join(cols)} FROM genetic_findings WHERE person = ? ORDER BY category, review_stars DESC, gene",
        (person,)).fetchall()]
    scols = ["provider", "filename", "build", "markers", "clinvar_release", "imported_at"]
    sources = [dict(zip(scols, row)) for row in conn.execute(
        f"SELECT {', '.join(scols)} FROM genetic_sources WHERE person = ? ORDER BY imported_at DESC", (person,)).fetchall()]
    return {"person": person, "findings": findings, "sources": sources}


def replace_findings(conn, person: str, source: dict, rows: list[dict]):
    """Re-importing a file replaces its findings, so variants ClinVar has since reclassified drop out."""
    conn.execute("DELETE FROM genetic_findings WHERE person = ? AND source_file = ?", (person, source["filename"]))
    conn.executemany(
        "INSERT INTO genetic_findings (person, category, gene, label, rsid, genotype, result, detected, classification, "
        "condition, review_stars, note, source_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (person, category, rsid, label) DO UPDATE SET genotype = excluded.genotype, result = excluded.result, "
        "detected = excluded.detected, classification = excluded.classification, condition = excluded.condition, "
        "review_stars = excluded.review_stars, note = excluded.note, source_file = excluded.source_file",
        [(person, r["category"], r.get("gene"), r["label"], r["rsid"], r.get("genotype"), r["result"], r["detected"],
          r.get("classification"), r.get("condition"), r.get("review_stars"), r.get("note"), source["filename"]) for r in rows],
    )
    conn.execute(
        "INSERT INTO genetic_sources (person, provider, filename, build, markers, clinvar_release) VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (person, filename) DO UPDATE SET provider = excluded.provider, build = excluded.build, "
        "markers = excluded.markers, clinvar_release = excluded.clinvar_release, imported_at = datetime('now')",
        (person, source["provider"], source["filename"], source.get("build"), source.get("markers"), source.get("clinvar_release")),
    )
    conn.commit()
