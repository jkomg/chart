# chart

Private, shared medical-record dashboard for two people. The app is designed around source PDFs: readable notes and summaries stay close to the original documents, while the data and PDF volume are persisted outside the container.

## Local development

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export CHART_PASSWORD_HASH="$(python3 -c 'from app import hash_password; print(hash_password(input()))')"
export CHART_SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
python3 app.py
```

Visit `http://localhost:8080/login` and sign in with username `family` unless `CHART_USERNAME` is changed. Add PDFs under `data/docs/`; add structured records in `data/medical.json`.

## k0s / Argo CD

The Kubernetes resources mirror the `home-automation` repo’s k0s conventions. The app expects `chart.lan.jkomg.us` to resolve to the cluster ingress and uses a 10Gi `local-path` PVC for `/data`.

Before syncing the Argo application:

1. The encrypted runtime secret belongs in the home-automation repo at `secrets/chart.sops.yaml`; it is intentionally not part of this app repo’s kustomization because Argo does not decrypt SOPS files.
2. Apply it from home-automation with `./scripts/apply-secret.sh secrets/chart.sops.yaml` after the cluster is reachable.
3. Make this repository available at `git@github.com:jkomg/chart.git` (or change the Argo `repoURL`).
4. Push `main`; GitHub Actions publishes `ghcr.io/jkomg/chart:latest`, then Argo CD reconciles the app.

Medical information is sensitive. Use HTTPS, a strong unique session secret, a strong password, encrypted Kubernetes secrets, and restrict DNS/network access as appropriate for the household.
