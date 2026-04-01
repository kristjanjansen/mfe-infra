# Plan: Full Argo + Traefik + Nexus

## Current State

GitHub Actions does everything: build → push ghcr.io → kubectl apply → record deploy event. Custom deploy.sh, nginx ingress, cert-manager, custom DAG dashboard. ghcr.io has auth issues (403 on push for some repos, needs Classic PAT with write:packages). Self-hosted runner on DO droplet ($24/mo).

## Target State

No GitHub Actions. No self-hosted runner. Everything runs on the cluster.

```
Developer pushes tag "rel-0.0.12" to mfe-billing repo
         ↓
GitHub sends webhook to cluster
         ↓
Argo Events receives webhook, triggers Argo Workflow
         ↓
Argo Workflow (runs as pods on cluster):
  1. git clone
  2. npm test
  3. kaniko build (no Docker daemon needed)
  4. push image to Nexus (cluster-local, no network hop)
  5. update services.json in mfe-infra, git push
         ↓
Argo CD detects change, syncs ConfigMap + Deployment
         ↓
Traefik routes traffic to new pod
         ↓
Browser picks up new URL on next page load
```

## Stack

| Component | What it does | Replaces |
|---|---|---|
| **Argo CD** | GitOps sync — watches mfe-infra repo, applies manifests | deploy.sh, kubectl, kubeconfig secret |
| **Argo Workflows** | CI pipelines + deploy DAG visualization | GitHub Actions, self-hosted runner, custom DAG dashboard |
| **Argo Events** | GitHub webhook → triggers Argo Workflow | GitHub Actions triggers |
| **Argo Rollouts** | Canary/blue-green deploys (live env only) | raw K8s Deployments |
| **Traefik** | Cluster ingress with built-in TLS | nginx ingress controller, cert-manager |
| **Nexus** | In-cluster container registry | ghcr.io, ghcr-pull secret, OCI labels, PAT auth |

## Traefik

Replaces **nginx ingress controller** (the cluster-level router), NOT the per-pod nginx:

```
Browser → Traefik (cluster ingress) → K8s Service → nginx (per-pod, serves static files)
```

Two different nginxes:
- **nginx ingress controller** = cluster add-on that routes `*.mfe.fachwerk.dev` to Services. **Traefik replaces this.**
- **nginx in Dockerfiles** = each MFE/host runs `FROM nginx:alpine` to serve static files. **This stays.**

Traefik benefits:
- `IngressRoute` CRD instead of nginx Ingress annotations
- Built-in ACME/Let's Encrypt (no separate cert-manager needed)
- Middleware chain for headers, CORS, rate limiting
- Traefik dashboard for debugging routing
- Wildcard cert: single `Certificate` resource, Traefik auto-serves

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

## Nexus

In-cluster container registry. Replaces ghcr.io entirely.

- Images stay in-cluster — no external network pull, faster deploys
- No ghcr.io auth issues (403 on push, Classic PAT requirement)
- No `ghcr-pull` imagePullSecret needed — Nexus is cluster-local
- No OCI source labels needed for repo linking
- Kaniko pushes directly from Argo Workflow pods — no Docker daemon, no network hop
- Nexus UI for browsing images, tags, storage

## Argo Events + Workflows (CI pipeline)

Replaces GitHub Actions entirely. Builds run as pods on the cluster.

### EventSource — listens for GitHub webhooks

```yaml
apiVersion: argoproj.io/v1alpha1
kind: EventSource
metadata:
  name: github
spec:
  github:
    mfe-repos:
      repositories:
        - owner: kristjanjansen
          names:
            - mfe-billing
            - mfe-dashboard
            - mfe-layout
            - mfe-cookiebot
            - mfe-api
            - mfe-translations
            - mfe-host-web
      events: [create]
      webhook:
        endpoint: /github
        port: "12000"
      apiToken:
        name: github-token
        key: token
```

### Sensor — matches tag events, triggers workflow

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Sensor
metadata:
  name: release
spec:
  dependencies:
    - name: tag-created
      eventSourceName: github
      eventName: mfe-repos
      filters:
        data:
          - path: body.ref_type
            type: string
            value: [tag]
          - path: body.ref
            type: string
            comparator: "="
            template: "rel-*"
  triggers:
    - template:
        name: run-pipeline
        argoWorkflow:
          operation: submit
          source:
            resource:
              # references the WorkflowTemplate below
          parameters:
            - src:
                dependencyName: tag-created
                dataKey: body.repository.name
              dest: spec.arguments.parameters.0.value
            - src:
                dependencyName: tag-created
                dataKey: body.ref
              dest: spec.arguments.parameters.1.value
```

### WorkflowTemplate — reused for all services

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: mfe-release
spec:
  arguments:
    parameters:
      - name: service
      - name: tag
  templates:
    - name: pipeline
      dag:
        tasks:
          - name: clone
            template: git-clone
          - name: test
            template: npm-test
            dependencies: [clone]
          - name: build
            template: kaniko-build
            dependencies: [test]
          - name: update-services
            template: update-services-json
            dependencies: [build]

    - name: git-clone
      container:
        image: alpine/git
        command: [sh, -c, "git clone --branch {{workflow.parameters.tag}} https://github.com/kristjanjansen/{{workflow.parameters.service}}.git /work"]

    - name: npm-test
      container:
        image: node:22-alpine
        command: [sh, -c, "cd /work && npm ci && npm test"]

    - name: kaniko-build
      container:
        image: gcr.io/kaniko-project/executor
        args:
          - --destination=nexus.internal:port/{{workflow.parameters.service}}:{{workflow.parameters.tag}}
          - --context=/work

    - name: update-services-json
      container:
        image: alpine/git
        command: [sh, -c, |
          git clone https://github.com/kristjanjansen/mfe-infra.git /infra
          cd /infra
          # update services.json with new version URL for this service
          # jq '.["{{workflow.parameters.service}}"].url = "https://{{workflow.parameters.tag | replace "." "-"}}--{{workflow.parameters.service}}.mfe.fachwerk.dev"' services.json > tmp && mv tmp services.json
          git add services.json
          git commit -m "release {{workflow.parameters.service}} {{workflow.parameters.tag}}"
          git push
        ]
```

Argo Workflows UI shows the DAG in real-time — each step lights up green as it completes.

## Argo CD (GitOps deploy)

Watches `mfe-infra` repo. When `services.json` or any manifest changes, auto-syncs to cluster.

### Application Structure

```
mfe-infra/
  argocd/
    apps/
      mfe-host-web.yaml
      mfe-billing.yaml
      mfe-dashboard.yaml
      mfe-layout.yaml
      mfe-cookiebot.yaml
      mfe-api.yaml
      mfe-translations.yaml
    appsets/
      preview.yaml              # ApplicationSet for preview envs
    projects/
      mfe.yaml                  # AppProject restricting access
```

### Example Application

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

## Argo Rollouts (live environment)

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

## services.json — single source of truth

One file drives runtime URLs, deploy ordering, DAG visualization, and version tracking.

### K8s deploy — ConfigMap

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

Mounted into host's nginx at `/usr/share/nginx/html/config/services.json`.

### Local dev — checked into mfe-host-web

```json
{
  "mfe-api":          { "url": "http://localhost:5000" },
  "mfe-translations": { "url": "http://localhost:5001" },
  "mfe-layout":       { "url": "http://localhost:4000" },
  "mfe-billing":      { "url": "http://localhost:4001" },
  "mfe-dashboard":    { "url": "http://localhost:4002" },
  "mfe-cookiebot":    { "url": "http://localhost:4003" }
}
```

### Code

Host loads once before React mounts:

```ts
const services = await fetch('/config/services.json').then(r => r.json())
window.__MFE_SERVICES__ = services
```

Then everywhere:

```ts
// host loading MFE script
useMfeScript(window.__MFE_SERVICES__['mfe-billing'].url + '/mf-billing.js')

// MFE calling API
fetch(window.__MFE_SERVICES__['mfe-api'].url + '/api/v1/bills')

// i18next config
backend: { loadPath: window.__MFE_SERVICES__['mfe-translations'].url + '/{lng}/{ns}.json' }
```

### DAG generation

`generate-workflow.mjs` reads `services.json` → outputs Argo Workflow YAML with DAG tasks and dependencies. The Argo Workflows UI renders the dependency graph with live status.

### Version updates

To promote mfe-billing from `rel-0-0-7` to `rel-0-0-8`:
1. Argo Workflow updates `services.json` automatically after build+push
2. Argo CD syncs the ConfigMap
3. Next page load picks up the new URL

Host image stays the same. No rebuild.

**Note:** All service communication is browser-based (fetch calls to external URLs). No server-to-server calls between pods.

## What gets deleted

- **GitHub Actions**: all `.github/workflows/` in every repo
- **Self-hosted runner**: DO droplet decommissioned ($24/mo saved)
- **ghcr.io**: all images, PAT, ghcr-pull secret
- **Custom scripts**: deploy.sh, record.sh, record.mjs, aggregate-datasets.mjs
- **Custom dashboard**: index.js, index.html on GitHub Pages (Argo Workflows UI replaces it)
- **Env var URL system**: `.env.services`, `.env` with `MFE_*_URL`, `envPrefix`, `import.meta.env.MFE_*`
- **K8s resources**: nginx ingress controller, cert-manager (if Traefik handles ACME)
- **Dockerfile labels**: `LABEL org.opencontainers.image.source`
- **K8s secrets**: kubeconfig, ghcr-pull, ghcr PAT

## What remains

- `mfe-infra/` repo with: Argo manifests, K8s manifests, services.json ConfigMap, Traefik IngressRoutes
- `mfe-host-web/public/config/services.json` — localhost URLs for dev
- `window.__MFE_SERVICES__['name'].url` — single source of truth in code
- nginx in Dockerfiles — serves static files per pod
- Nexus — container registry
- One WorkflowTemplate — reused for all services
- One EventSource + one Sensor — triggers on any mfe repo tag

## Migration Steps

1. **Inventory**: verify Traefik, Argo CD, Argo Workflows, Argo Events, Nexus are running. Find endpoints, ports, credentials.
2. **Nexus**: create `mfe` Docker registry, test manual push/pull
3. **Traefik**: convert one service (mfe-api) from nginx Ingress → Traefik IngressRoute. Verify routing + TLS.
4. **Argo CD**: create Application for mfe-api pointing to mfe-infra manifests. Verify: push manifest change → auto-sync.
5. **Kaniko build**: test building mfe-api with kaniko → push to Nexus (manual Workflow submission)
6. **Argo Workflow**: create WorkflowTemplate for the full pipeline (clone → test → build → update services.json). Test with manual trigger.
7. **Argo Events**: set up EventSource (GitHub webhook) + Sensor (tag filter). Push a test tag → verify full pipeline fires.
8. **Convert remaining services**: same pattern for all 7 services.
9. **services.json**: add `public/config/services.json` to host, update code to use `window.__MFE_SERVICES__`, remove env var URL system.
10. **Argo Rollouts**: convert live Deployments to Rollouts with canary strategy.
11. **Cleanup**: delete GitHub Actions workflows, decommission runner droplet, remove ghcr.io images + secrets, remove custom dashboard + deploy scripts.
