# chart

Private, shared medical-record dashboard for two people. The app is designed around source PDFs: readable notes and summaries stay close to the original documents.

This repository is public. Never commit medical data, PDFs, `.env`, or real secrets.

## Deploys

Production is Cloud Run (`chart` in GCP project `chart-jkomg`, us-east1), served at https://chart.jkomg.us.

- Pull requests: GitHub Actions builds the image as a check.
- Merges to `main`: Actions authenticates to GCP with Workload Identity Federation (no stored keys), pushes `us-east1-docker.pkg.dev/chart-jkomg/chart/chart:<sha>`, and rolls out a new revision.

Runtime config lives on the Cloud Run service, not in this repo:

| Variable | Source |
| --- | --- |
| `CHART_USERS` | Secret Manager `chart-users`: `{"jason": "<hash>", "mia": "<hash>"}` |
| `CHART_SESSION_SECRET` | Secret Manager `chart-session-secret` |
| `TURSO_AUTH_TOKEN` | Secret Manager `turso-auth-token` |
| `TURSO_DATABASE_URL` | env, Turso db `chart` |
| `GCS_BUCKET` | env, `chart-jkomg-docs` (PDFs under `docs/`) |
| `CHART_COOKIE_SECURE` | env, `true` |

Generate a password hash with `python3 -c 'from app import hash_password; print(hash_password(input()))'`.

## Loading data

Source files go in `Data/` at the repo root. It's gitignored and never committed or built into the image.

```
Data/
  mia/export.zip            Apple Health export (Health app > profile > Export All Health Data)
  jason/export.zip
  extracted/*.json          values pulled from a PDF, plus the PDF itself alongside it
```

`scripts/chart_import.py` previews what it found and writes only with `--commit`. `--prod` targets the production Turso db via the `turso` CLI.

```sh
scripts/chart_import.py apple-health Data/mia/export.zip --person mia --prod            # preview
scripts/chart_import.py apple-health Data/mia/export.zip --person mia --prod --commit
scripts/chart_import.py manifest Data/extracted/2026-09-07_visit.json --prod --commit  # also uploads the PDF
```

A manifest ties each value to the page it came from, so the app can open the PDF at that page:

```json
{
  "document": "2026-09-07_visit.pdf",
  "person": "mia",
  "measurements": [
    {"metric": "bp_systolic", "value": 112, "taken_at": "2026-09-07", "page": 2},
    {"metric": "weight", "value": 133.4, "taken_at": "2026-09-07", "page": 2, "note": "clinic scale"}
  ],
  "cycles": [{"start": "2026-08-30", "end": "2026-09-03", "page": 3}]
}
```

Metric keys and units are defined in `vitals.py` (`METRICS`). Re-importing the same file updates rows instead of duplicating them.

## Local development

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export CHART_USERS="{\"jason\": \"$(python3 -c 'from app import hash_password; print(hash_password(input()))')\"}"
export CHART_SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export CHART_COOKIE_SECURE=false
export TURSO_DATABASE_URL=file:local.db   # or a Turso dev database
export CHART_LOCAL_DOCS_DIR=Data/extracted  # serve PDFs from disk instead of the bucket
python3 app.py
```

## k0s (LAN)

`cluster/k0s/apps/chart` is synced by Argo CD to `chart.lan.jkomg.us`. It's pinned to an older arm64 image that stores data on a PVC, because newer images need Turso/GCS and have no arm64 build.
