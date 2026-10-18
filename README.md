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

## Local development

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export CHART_USERS="{\"jason\": \"$(python3 -c 'from app import hash_password; print(hash_password(input()))')\"}"
export CHART_SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export CHART_COOKIE_SECURE=false
export TURSO_DATABASE_URL=file:local.db   # or a Turso dev database
python3 app.py
```

Without `GCS_BUCKET`, the document list is empty and uploads fail.

## k0s (LAN)

`cluster/k0s/apps/chart` is synced by Argo CD to `chart.lan.jkomg.us`. It's pinned to an older arm64 image that stores data on a PVC, because newer images need Turso/GCS and have no arm64 build.
