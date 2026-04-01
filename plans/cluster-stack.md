# Plan: Argo Stack + Traefik + Nexus Migration

## Current State

GitHub Actions does everything: build → push ghcr.io → kubectl apply → record deploy event. Custom deploy.sh, nginx ingress, cert-manager, custom DAG dashboard. ghcr.io has auth issues (403 on push for some repos, needs Classic PAT with write:packages).

## Stack

| Component | What it does | Replaces |
|---|---|---|
| **Argo CD** | GitOps sync — watches git repo, applies manifests to cluster | deploy.sh, kubectl in CI, kubeconfig secret |
| **Argo Rollouts** | Canary/blue-green deploys with automatic rollback | raw K8s Deployments, manual rollback |
| **Argo Workflows** | DAG-based CI pipelines running on K8s | GitHub Actions build/push steps |
| **Argo Events** | Event triggers (GitHub webhook → Argo Workflow) | GitHub Actions webhook triggers |
| **Traefik** | Ingress controller with built-in TLS | nginx ingress, cert-manager |
| **Nexus** | In-cluster container registry | ghcr.io, ghcr-pull secret, OCI labels, PAT auth |

## What to Adopt

### Phase 1: Argo CD + Traefik (immediate value)

**Argo CD** replaces deploy.sh entirely:
- Manifests live in `mfe-infra/k8s/` (already do)
- Argo watches the repo, auto-syncs on push
- One `Application` per service, or `ApplicationSet` to generate from directory structure
- Preview environments: `ApplicationSet` with git branch generator
- Rollback = git revert → Argo auto-syncs
- Built-in DAG visualization of applications and their resources — may replace custom dashboard
- Argo CD notifications (webhook/Slack) can replace deploy event recording

**Traefik** replaces **nginx ingress controller** (the cluster-level router), NOT the per-pod nginx:

```
Browser → Traefik (cluster ingress) → K8s Service → nginx (per-pod, serves static files)
```

Two different nginxes:
- **nginx ingress controller** = cluster add-on that routes `*.mfe.fachwerk.dev` to Services. Traefik replaces this.
- **nginx in Dockerfiles** = each MFE/host runs `FROM nginx:alpine` to serve static files. This stays — it's the app server.

Traefik benefits:
- `IngressRoute` CRD instead of nginx Ingress annotations
- Built-in ACME/Let's Encrypt (no separate cert-manager needed)
- Middleware chain for headers, CORS, rate limiting
- Traefik dashboard for debugging routing
- Wildcard cert: single `Certificate` resource, Traefik auto-serves

**Nexus** replaces ghcr.io as the container registry:
- Images stay in-cluster — no external network pull, faster deploys
- No ghcr.io auth issues (403 on push, Classic PAT requirement)
- No `ghcr-pull` imagePullSecret needed — Nexus is cluster-local
- No OCI source labels needed for repo linking
- Push via `docker push nexus.internal:port/mfe-billing:rel-0.0.7`
- Nexus UI for browsing images, tags, storage

**What GitHub Actions still does:**
- Build Docker image
- Push to Nexus (instead of ghcr.io)
- Update version in manifest file (triggers Argo sync)
- Run tests

**What GitHub Actions stops doing:**
- kubectl apply (Argo CD does this)
- kubeconfig secret (not needed for deploy — still needed for Nexus push unless using Argo Workflows)
- deploy.sh (deleted)
- record-deploy-event (Argo notifications replace this)
- .env.services resolution (moves to Kustomize or Argo CD config)
- ghcr.io login step
- OCI label injection in Dockerfiles

**What gets removed from repos:**
- `LABEL org.opencontainers.image.source` from all Dockerfiles
- `ghcr-pull` secret from K8s manifests
- `imagePullSecrets` from all Deployment specs
- ghcr.io PAT from GitHub secrets

### Phase 2: Argo Rollouts (for live environment)

Replace `Deployment` with `Rollout` for production services:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: mfe-billing
spec:
  strategy:
    canary:
      steps:
        - setWeight: 20
        - pause: { duration: 5m }
        - setWeight: 50
        - pause: { duration: 5m }
        - setWeight: 100
```

- Canary: route 20% → 50% → 100% traffic to new version
- Automatic rollback if health checks fail
- Traefik integration via TraefikService for traffic splitting
- Only needed for `live` environment, not previews

### Phase 3: Argo Events + Workflows (deploy orchestration + DAG visualization)

**Argo Workflows** gives two things: CI pipelines AND dependency-aware deploy orchestration with a visual DAG.

**Deploy DAG** — services deploy in dependency order, Argo Workflows UI shows the graph in real-time:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
spec:
  templates:
    - name: deploy-all
      dag:
        tasks:
          - name: mfe-api
            template: deploy
          - name: mfe-translations
            template: deploy
          - name: mfe-billing
            template: deploy
            dependencies: [mfe-api, mfe-translations]
          - name: mfe-dashboard
            template: deploy
            dependencies: [mfe-api, mfe-translations]
          - name: mfe-cookiebot
            template: deploy
            dependencies: [mfe-translations]
          - name: mfe-layout
            template: deploy
          - name: mfe-host-web
            template: deploy
            dependencies: [mfe-layout, mfe-billing, mfe-dashboard, mfe-cookiebot]
```

This replaces the custom GitHub Pages DAG dashboard — Argo Workflows UI renders the graph with live status (green/yellow/red) as each service deploys.

**CI pipelines** — build/push per service:

```yaml
dag:
  tasks:
    - name: build
      template: docker-build
    - name: push
      template: docker-push
      dependencies: [build]
    - name: update-manifest
      template: git-commit
      dependencies: [push]
```

**Argo Events**: GitHub webhook → EventSource → Sensor → triggers the right Workflow.

**Trade-off**: Replaces GitHub Actions entirely — builds run on the cluster. Pros: no self-hosted runner needed, push to Nexus locally (no network hops), full K8s native, visual DAG. Cons: cluster pays for CI compute, more infra to manage.

**With Nexus**: builds push to Nexus directly from the cluster. The self-hosted runner droplet ($24/mo) could be decommissioned.

### services.json as single source of truth

`services.json` drives everything — URLs, dependencies, versions:

```json
{
  "mfe-api": {
    "url": "https://rel-0-0-7--mfe-api.mfe.fachwerk.dev",
    "dependencies": []
  },
  "mfe-translations": {
    "url": "https://rel-0-0-7--mfe-translations.mfe.fachwerk.dev",
    "dependencies": []
  },
  "mfe-billing": {
    "url": "https://rel-0-0-7--mfe-billing.mfe.fachwerk.dev",
    "dependencies": ["mfe-api", "mfe-translations"]
  },
  "mfe-dashboard": {
    "url": "https://rel-0-0-7--mfe-dashboard.mfe.fachwerk.dev",
    "dependencies": ["mfe-api", "mfe-translations"]
  },
  "mfe-cookiebot": {
    "url": "https://rel-0-0-7--mfe-cookiebot.mfe.fachwerk.dev",
    "dependencies": ["mfe-translations"]
  },
  "mfe-layout": {
    "url": "https://rel-0-0-7--mfe-layout.mfe.fachwerk.dev",
    "dependencies": []
  },
  "mfe-host-web": {
    "url": "https://rel-0-0-10--mfe-host-web.mfe.fachwerk.dev",
    "dependencies": ["mfe-layout", "mfe-billing", "mfe-dashboard", "mfe-cookiebot"]
  }
}
```

**What this file provides:**
1. **Runtime URLs** — browser reads `.url` to load scripts, call API, fetch translations
2. **Deploy ordering** — `.dependencies` determines which services deploy first
3. **DAG visualization** — Argo Workflow generated from `.dependencies`
4. **Version tracking** — version is embedded in the URL

**Generation:** A script (`generate-workflow.mjs`) reads `services.json` → outputs the Argo Workflow YAML with DAG tasks and dependencies. Runs in CI when `services.json` changes.

**Local dev** — same file, flat URLs (dependencies not needed in browser):

```json
{
  "mfe-api": { "url": "http://localhost:5000" },
  "mfe-billing": { "url": "http://localhost:4001" },
  "mfe-dashboard": { "url": "http://localhost:4002" },
  "mfe-cookiebot": { "url": "http://localhost:4003" },
  "mfe-layout": { "url": "http://localhost:4000" },
  "mfe-translations": { "url": "http://localhost:5001" }
}
```

**Host code reads `.url`:**

```ts
window.__MFE_SERVICES__['mfe-billing'].url
```

## Argo CD Application Structure

```
mfe-infra/
  argocd/
    apps/                          # Application manifests
      mfe-host-web.yaml
      mfe-billing.yaml
      mfe-dashboard.yaml
      mfe-layout.yaml
      mfe-cookiebot.yaml
      mfe-api.yaml
      mfe-translations.yaml
    appsets/
      preview.yaml                 # ApplicationSet for preview envs
    projects/
      mfe.yaml                     # AppProject restricting access
```

Each Application points to `mfe-infra/k8s/` manifests:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: mfe-billing
  namespace: argocd
spec:
  project: mfe
  source:
    repoURL: https://github.com/kristjanjansen/mfe-infra
    path: k8s/overlays/preview/mfe-billing
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Traefik IngressRoute

Replaces current nginx Ingress:

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: mfe-billing-preview
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`rel-0-0-7--mfe-billing.mfe.fachwerk.dev`)
      kind: Rule
      services:
        - name: mfe-billing
          port: 4000
  tls:
    secretName: mfe-wildcard-tls
```

## Runtime Service Config (replaces .env.services, .env, env vars)

### The problem

URLs are scattered across multiple mechanisms:
- `.env` files with `MFE_*_URL` / `VITE_*_URL` vars (local dev)
- `.env.services` with version → URL resolution (deploy)
- `import.meta.env.MFE_API_URL` in code (build-time baking)
- `envPrefix: ["MFE_", "VITE_"]` in Vite configs (custom prefix)

Changing a dependency version means rebuilding the host Docker image.

### The solution: one `services.json` file

All URLs in one file. Same pattern for local dev and K8s deploy.

**3 types of URLs the browser needs:**
1. MFE scripts — host loads `<script src=".../mf-billing.js">`
2. API — MFEs call `fetch(".../api/v1/bills")`
3. Translations — i18next fetches `.../en/common.json`

**Local dev** — checked into `mfe-host-web/public/config/services.json`:

```json
{
  "mfe-api": { "url": "http://localhost:5000" },
  "mfe-translations": { "url": "http://localhost:5001" },
  "mfe-layout": { "url": "http://localhost:4000" },
  "mfe-billing": { "url": "http://localhost:4001" },
  "mfe-dashboard": { "url": "http://localhost:4002" },
  "mfe-cookiebot": { "url": "http://localhost:4003" }
}
```

**K8s deploy** — ConfigMap mounts over the same path with real URLs + dependencies:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mfe-services
data:
  services.json: |
    {
      "mfe-api":          { "url": "https://rel-0-0-7--mfe-api.mfe.fachwerk.dev",          "dependencies": [] },
      "mfe-translations": { "url": "https://rel-0-0-7--mfe-translations.mfe.fachwerk.dev", "dependencies": [] },
      "mfe-layout":       { "url": "https://rel-0-0-7--mfe-layout.mfe.fachwerk.dev",       "dependencies": [] },
      "mfe-billing":      { "url": "https://rel-0-0-7--mfe-billing.mfe.fachwerk.dev",      "dependencies": ["mfe-api", "mfe-translations"] },
      "mfe-dashboard":    { "url": "https://rel-0-0-7--mfe-dashboard.mfe.fachwerk.dev",    "dependencies": ["mfe-api", "mfe-translations"] },
      "mfe-cookiebot":    { "url": "https://rel-0-0-7--mfe-cookiebot.mfe.fachwerk.dev",    "dependencies": ["mfe-translations"] },
      "mfe-host-web":     { "url": "https://rel-0-0-10--mfe-host-web.mfe.fachwerk.dev",    "dependencies": ["mfe-layout", "mfe-billing", "mfe-dashboard", "mfe-cookiebot"] }
    }
```

ConfigMap is mounted into the host's nginx container at `/usr/share/nginx/html/config/services.json`, replacing the dev file. Same path, different content. Dependencies are used by `generate-workflow.mjs` to produce the Argo Workflow DAG, and ignored by the browser.

### Code changes

**Host loads once before React mounts** (same pattern as country config):

```ts
// host main.tsx
const services = await fetch('/config/services.json').then(r => r.json())
window.__MFE_SERVICES__ = services
```

**Then everywhere — one way to get any URL:**

```ts
// host loading MFE script
useMfeScript(window.__MFE_SERVICES__['mfe-billing'].url + '/mf-billing.js')

// MFE calling API
fetch(window.__MFE_SERVICES__['mfe-api'].url + '/api/v1/bills')

// i18next config
backend: { loadPath: window.__MFE_SERVICES__['mfe-translations'].url + '/{lng}/{ns}.json' }
```

All MFEs share the same `window` (shadow DOM doesn't isolate JS globals), so `window.__MFE_SERVICES__` is accessible everywhere.

### What gets deleted

- All `.env.services` files (all repos)
- All `.env` files with `MFE_*_URL` / `VITE_*_URL` vars
- `envPrefix: ["MFE_", "VITE_"]` from Vite configs
- All `import.meta.env.MFE_*` references in code
- URL resolution logic in deploy scripts
- `VITE_TRANSLATIONS_URL` env var
- `VITE_API_URL` env var

### What remains

- `mfe-host-web/public/config/services.json` — localhost URLs for dev (checked in)
- One ConfigMap per K8s environment — real URLs for deploy
- `window.__MFE_SERVICES__['name'].url` — single source of truth in code
- No env vars for URLs. No prefixes. No build-time baking.

### How version updates work

To promote mfe-billing from `rel-0-0-7` to `rel-0-0-8`:

1. Edit the ConfigMap in `mfe-infra/k8s/` (change one URL)
2. Push to git
3. Argo CD syncs the ConfigMap
4. Next page load picks up the new URL

Host image stays the same. No rebuild. No redeploy of the host pod.

**Note:** All service communication is browser-based (fetch calls to external URLs). No server-to-server calls between pods. K8s internal DNS is not relevant to this architecture.

## DAG Dashboard

Argo CD has a built-in UI showing:
- All Applications and their sync status
- Resource tree per Application (Deployment → ReplicaSet → Pod)
- Health status, last sync time, git commit

This partially replaces the custom GitHub Pages dashboard. The custom dashboard still has value for showing **cross-service dependencies** (billing → api, billing → translations) which Argo CD doesn't model — each Application is independent.

Options:
1. Keep custom dashboard for dependency graph, use Argo CD UI for deploy status
2. Model dependencies as Argo CD sync waves (api deploys before billing)
3. Use Argo CD resource hooks to enforce ordering

## Migration Steps

1. Inventory: verify Traefik, Argo CD, Nexus are running, find their endpoints/ports
2. Configure Nexus: create `mfe` Docker registry, test push/pull from runner
3. Rebuild one image (mfe-api) → push to Nexus instead of ghcr.io
4. Update mfe-api K8s manifest: image from Nexus, remove imagePullSecrets, switch Ingress → IngressRoute
5. Create Argo CD Application for mfe-api pointing to manifest in mfe-infra repo
6. Verify: push manifest change → Argo syncs → Traefik routes traffic → image pulled from Nexus
7. Convert remaining services (same pattern)
8. Update GitHub Actions: remove deploy.sh step, replace ghcr.io push with Nexus push, add "update manifest version" step
9. Set up Argo CD notifications (webhook to record deploys, or Slack)
10. Remove: deploy.sh, ghcr-pull secret, kubeconfig secret (if no longer needed), nginx ingress resources, cert-manager (if Traefik handles ACME), OCI labels from Dockerfiles
11. Set up ApplicationSet for preview environments
12. (Phase 2) Convert live Deployments to Argo Rollouts
13. (Phase 3, optional) Argo Events + Workflows → decommission self-hosted runner
