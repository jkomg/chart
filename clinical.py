"""Everything extracted from source documents (see scripts/EXTRACTION.md), per account.

Each row points at the document (bucket filename) and page it came from. Importing a manifest
replaces all rows for that document, so re-extracting a PDF never leaves stale or duplicate rows.
"""

TABLES = {
    "documents": ["document", "title", "date", "provider", "clinician", "kind", "summary"],
    "lab_results": ["test", "test_reported", "panel", "value", "value_text", "unit", "ref_low", "ref_high", "ref_text", "flag", "taken_at", "document", "page"],
    "events": ["date", "type", "title", "detail", "document", "page"],
    "diagnoses": ["name", "icd10", "date", "status", "note", "document", "page"],
    "medications": ["name", "dose", "schedule", "context", "date", "document", "page"],
    "allergies": ["substance", "reaction", "document", "page"],
    "family_history": ["relation", "condition", "document", "page"],
    "clinical_genetics": ["test", "gene", "variant", "protein", "classification", "zygosity", "condition", "inheritance", "note", "document", "page"],
}
REAL = {"value", "ref_low", "ref_high"}
INTEGER = {"page"}

# manifest key -> table
SECTIONS = {
    "labs": "lab_results", "events": "events", "diagnoses": "diagnoses", "medications": "medications",
    "allergies": "allergies", "family_history": "family_history", "genetic_findings": "clinical_genetics",
}

# Different labs print the same test differently. Map to one name so results trend together;
# the printed name is kept in test_reported.
LAB_ALIASES = {
    "a/g ratio": "Albumin/globulin ratio", "albumin/globulin ratio": "Albumin/globulin ratio",
    "basophils": "Basophils %", "eosinophils": "Eosinophils %", "lymphocytes": "Lymphocytes %",
    "monocytes": "Monocytes %", "neutrophils": "Neutrophils %",
    "absolute basophils": "Basophils, absolute", "absolute eosinophils": "Eosinophils, absolute",
    "absolute lymphocytes": "Lymphocytes, absolute", "absolute monocytes": "Monocytes, absolute",
    "absolute neutrophils": "Neutrophils, absolute",
    "blood urea nitrogen (bun)": "BUN", "bun/creatinine ratio": "BUN/creatinine ratio",
    "c-reactive protein, high sensitivity": "hs-CRP", "c-reactive protein, high sensitivity (hs-crp)": "hs-CRP",
    "c-reactive protein, high-sensitivity (hs-crp)": "hs-CRP",
    "carbon dioxide (co2)": "Carbon dioxide", "carbon dioxide, total": "Carbon dioxide",
    "creatine kinase (ck), total": "Creatine kinase, total",
    "anti-mullerian hormone (amh)": "Anti-Mullerian hormone",
    "follicle-stimulating hormone (fsh)": "FSH", "luteinizing hormone (lh)": "LH",
    "gamma-glutamyl transferase (ggt)": "GGT", "globulin, total": "Globulin",
    "iron, serum": "Iron", "iron, total": "Iron", "transferrin saturation": "Iron saturation",
    "total iron binding capacity (tibc)": "Total iron binding capacity", "total iron-binding capacity (tibc)": "Total iron binding capacity",
    "ldl cholesterol (calculated)": "LDL cholesterol", "lipoprotein(a)": "Lipoprotein (a)",
    "red blood cell count (rbc)": "Red blood cell count", "white blood cell count (wbc)": "White blood cell count",
    "sedimentation rate (esr)": "Erythrocyte sedimentation rate (ESR)",
    "sex hormone binding globulin (shbg)": "Sex hormone binding globulin", "sex hormone-binding globulin (shbg)": "Sex hormone binding globulin",
    "thyroglobulin antibody": "Thyroglobulin antibodies",
    "thyroid peroxidase antibodies (tpo)": "Thyroid peroxidase antibodies", "thyroid peroxidase antibody (tpo ab)": "Thyroid peroxidase antibodies",
    "immunoglobulin a": "IgA", "zinc, plasma": "Zinc", "lead, blood (venous)": "Lead, blood", "cortisol, am": "Cortisol, total",
    "omega-6/omega-3 ratio": "Omega-6/omega-3 ratio",
    "omega-3 total": "Omega-3 fatty acids, total", "omega-3 fatty acids, total %": "Omega-3 fatty acids, total",
    "omega-6 total": "Omega-6 fatty acids, total", "omega-6 fatty acids, total %": "Omega-6 fatty acids, total",
    "saturated fatty acids, total %": "Saturated fatty acids, total",
    "arachidonic acid (aa)": "Arachidonic acid", "docosahexaenoic acid (dha)": "DHA", "eicosapentaenoic acid (epa)": "EPA",
    "docosapentaenoic acid (dpa)": "DPA", "docosapentaenoic acid n-3 (dpa)": "DPA", "linoleic acid (la)": "Linoleic acid",
    "dihomo-gamma-linolenic acid (dgla)": "Dihomo-gamma-linolenic acid", "gamma-linolenic acid (gla)": "Gamma-linolenic acid",
    "docosatetraenoic acid (dta)": "Docosatetraenoic acid", "aa/epa ratio": "Arachidonic acid/EPA ratio",
    "urobilinogen, urine": "Urine urobilinogen", "urine occult blood": "Urine blood",
    "egfr (non-african american)": "eGFR",
    "sars-cov-2 spike total antibody": "SARS-CoV-2 spike antibody, total", "sars-cov-2 total antibody, spike (s)": "SARS-CoV-2 spike antibody, total",
    "sars-cov-2 spike antibody interpretation": "SARS-CoV-2 spike antibody, interpretation",
    "sars-cov-2 total antibody, spike (s) interpretation": "SARS-CoV-2 spike antibody, interpretation",
    "sars-cov-2 nucleocapsid total antibody index": "SARS-CoV-2 nucleocapsid antibody, index",
    "sars-cov-2 total antibody, nucleocapsid (n) index": "SARS-CoV-2 nucleocapsid antibody, index",
    "sars-cov-2 nucleocapsid antibody interpretation": "SARS-CoV-2 nucleocapsid antibody, interpretation",
    "sars-cov-2 total antibody, nucleocapsid (n) interpretation": "SARS-CoV-2 nucleocapsid antibody, interpretation",
    "ana": "ANA screen", "ana screen, ifa": "ANA screen", "ana screen (ifa)": "ANA screen",
    "neutrophils, absolute (manual)": "Neutrophils, absolute", "lymphocytes, absolute (manual)": "Lymphocytes, absolute",
    "monocytes, absolute (manual)": "Monocytes, absolute", "eosinophils, absolute (manual)": "Eosinophils, absolute",
    "basophils, absolute (manual)": "Basophils, absolute", "nucleated rbcs (automated)": "Nucleated RBCs",
}

# Spellings of the same unit, and unit changes that need the value scaled.
UNIT_SAME = {
    "iu/l": "U/L", "meq/l": "mmol/L", "ug/dl": "mcg/dL", "uiu/ml": "mIU/L",
    "% of total hgb": "%", "% by wt": "%", "wt %": "%", "/hpf": "/HPF", "ml/min/1.73": "mL/min/1.73m2",
    "mm/hour": "mm/hr", "thousand/ul": "K/uL", "x10e3/ul": "K/uL", "million/ul": "M/uL", "x10e6/ul": "M/uL",
    "ratio": None, "(calc)": None, "calc": None, "ratio (x:1)": None,
}
HORMONE_IU = {"FSH", "LH"}


def normalize_lab(row: dict) -> dict:
    row = dict(row)
    row["test_reported"] = row.get("test_reported") or row["test"]
    row["test"] = LAB_ALIASES.get(row["test"].lower(), row["test"])
    unit = (row.get("unit") or "").strip()
    unit = unit.replace(" (calc)", "")
    key = unit.lower()
    if row["test"] in HORMONE_IU and key == "iu/l":
        unit = "mIU/mL"  # numerically identical
    elif key in UNIT_SAME:
        unit = UNIT_SAME[key]
    if key == "cells/ul" and row["test"].endswith(", absolute"):
        for k in ("value", "ref_low", "ref_high"):
            if row.get(k) is not None:
                row[k] = round(row[k] / 1000, 3)
        unit = "K/uL"
    if not unit and row["test_reported"].rstrip().endswith("%"):
        unit = "%"  # e.g. "Omega-3 fatty acids, total %"
    row["unit"] = unit or None
    return row


def init_schema(conn):
    for table, cols in TABLES.items():
        defs = ", ".join(f"{c} {'REAL' if c in REAL else 'INTEGER' if c in INTEGER else 'TEXT'}" for c in cols)
        conn.execute(f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY, person TEXT NOT NULL, {defs})")
        conn.execute(f"CREATE INDEX IF NOT EXISTS {table}_person ON {table} (person{', document' if table != 'documents' else ''})")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS documents_person_document ON documents (person, document)")
    conn.commit()


def replace_document(conn, person: str, manifest: dict):
    doc = manifest["document"]
    for table in TABLES:
        conn.execute(f"DELETE FROM {table} WHERE person = ? AND document = ?", (person, doc))
    meta = {k: manifest.get(k) for k in TABLES["documents"]}
    meta["document"] = doc
    _insert(conn, "documents", person, [meta])
    for key, table in SECTIONS.items():
        rows = [{**row, "document": doc} for row in manifest.get(key, [])]
        if key == "labs":
            rows = [normalize_lab(r) for r in rows]
        _insert(conn, table, person, rows)
    conn.commit()


def _insert(conn, table, person, rows):
    cols = TABLES[table]
    if not rows:
        return
    conn.executemany(
        f"INSERT INTO {table} (person, {', '.join(cols)}) VALUES (?, {', '.join('?' * len(cols))})",
        [(person, *[row.get(c) for c in cols]) for row in rows],
    )


def load_clinical(conn, person: str) -> dict:
    out = {}
    order = {"documents": "date DESC", "lab_results": "test, taken_at", "events": "date DESC", "diagnoses": "date DESC",
             "medications": "date DESC", "allergies": "substance", "family_history": "relation", "clinical_genetics": "test"}
    for table, cols in TABLES.items():
        rows = conn.execute(f"SELECT {', '.join(cols)} FROM {table} WHERE person = ? ORDER BY {order[table]}", (person,)).fetchall()
        out[table] = [dict(zip(cols, r)) for r in rows]
    return out
