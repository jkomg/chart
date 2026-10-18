"""Vitals and menstrual-cycle storage.

One row per reading in `measurements`, one row per period in `cycles`. Every row can point
back at the PDF (and page) it came from, so the UI can jump from a chart to its source.
Values are stored in each metric's canonical unit below; importers convert on the way in.
"""

METRICS = {
    # key: label, canonical unit, decimals, typical adult range (shaded on the chart) or None
    "weight": {"label": "Weight", "unit": "lb", "decimals": 1, "range": None},
    "resting_hr": {"label": "Resting heart rate", "unit": "bpm", "decimals": 0, "range": [60, 100]},
    "hrv_sdnn": {"label": "Heart rate variability (SDNN)", "unit": "ms", "decimals": 0, "range": None},
    "hrv_rmssd": {"label": "Heart rate variability (RMSSD)", "unit": "ms", "decimals": 0, "range": None},
    "bp_systolic": {"label": "Systolic", "unit": "mmHg", "decimals": 0, "range": [90, 120]},
    "bp_diastolic": {"label": "Diastolic", "unit": "mmHg", "decimals": 0, "range": [60, 80]},
    "spo2": {"label": "Blood oxygen", "unit": "%", "decimals": 0, "range": [95, 100]},
    "respiratory_rate": {"label": "Respiratory rate", "unit": "breaths/min", "decimals": 1, "range": [12, 20]},
    "body_temp": {"label": "Body temperature", "unit": "°F", "decimals": 1, "range": [97, 99]},
    "temp_deviation": {"label": "Temperature deviation", "unit": "°C", "decimals": 2, "range": None},
    "vo2max": {"label": "VO₂ max", "unit": "mL/kg/min", "decimals": 1, "range": None},
}

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS measurements (
        id INTEGER PRIMARY KEY,
        person TEXT NOT NULL,
        metric TEXT NOT NULL,
        taken_at TEXT NOT NULL,          -- ISO date (YYYY-MM-DD) or datetime
        value REAL NOT NULL,
        source TEXT NOT NULL,            -- apple_health | oura | pdf | manual
        doc TEXT,                        -- source PDF filename in the docs bucket
        page INTEGER,
        note TEXT,
        UNIQUE (person, metric, taken_at, source)
    )""",
    "CREATE INDEX IF NOT EXISTS measurements_person_metric ON measurements (person, metric, taken_at)",
    """CREATE TABLE IF NOT EXISTS cycles (
        id INTEGER PRIMARY KEY,
        person TEXT NOT NULL,
        start_date TEXT NOT NULL,        -- first day of the period
        end_date TEXT,                   -- last day of bleeding, if known
        source TEXT NOT NULL,
        doc TEXT,
        page INTEGER,
        note TEXT,
        UNIQUE (person, start_date)
    )""",
]


def init_schema(conn):
    for statement in SCHEMA:
        conn.execute(statement)
    conn.commit()


def load_vitals(conn, person: str) -> dict:
    rows = conn.execute(
        "SELECT metric, taken_at, value, source, doc, page, note FROM measurements WHERE person = ? ORDER BY taken_at",
        (person,),
    ).fetchall()
    series: dict[str, list] = {}
    for metric, taken_at, value, source, doc, page, note in rows:
        if metric in METRICS:
            series.setdefault(metric, []).append({"t": taken_at, "v": value, "source": source, "doc": doc, "page": page, "note": note})
    cycles = [
        {"start": start, "end": end, "source": source, "doc": doc, "page": page, "note": note}
        for start, end, source, doc, page, note in conn.execute(
            "SELECT start_date, end_date, source, doc, page, note FROM cycles WHERE person = ? ORDER BY start_date",
            (person,),
        ).fetchall()
    ]
    return {"person": person, "metrics": METRICS, "series": series, "cycles": cycles}


def upsert_measurements(conn, rows):
    """rows: iterable of (person, metric, taken_at, value, source, doc, page, note)."""
    conn.executemany(
        "INSERT INTO measurements (person, metric, taken_at, value, source, doc, page, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (person, metric, taken_at, source) DO UPDATE SET value = excluded.value, doc = excluded.doc, "
        "page = excluded.page, note = excluded.note",
        list(rows),
    )
    conn.commit()


def upsert_cycles(conn, rows):
    """rows: iterable of (person, start_date, end_date, source, doc, page, note)."""
    conn.executemany(
        "INSERT INTO cycles (person, start_date, end_date, source, doc, page, note) VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (person, start_date) DO UPDATE SET end_date = excluded.end_date, source = excluded.source, "
        "doc = excluded.doc, page = excluded.page, note = excluded.note",
        list(rows),
    )
    conn.commit()
