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

**Traefik** replaces nginx ingress + possibly cert-manager:
- `IngressRoute` CRD instead of nginx Ingress
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

### Phase 3: Argo Events + Workflows (optional, evaluate later)

**Argo Events**: GitHub webhook → EventSource → Sensor → triggers Argo Workflow

**Argo Workflows**: DAG-based pipelines on K8s:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
spec:
  templates:
    - name: pipeline
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

**Trade-off**: This replaces GitHub Actions entirely — builds run on the cluster instead of GitHub runners. Pros: no self-hosted runner needed, full K8s native. Cons: cluster pays for CI compute, GitHub Actions UI is familiar, more infra to manage.

**Recommendation**: Defer Phase 3. GitHub Actions for build/push works fine. The self-hosted runner is already set up. Argo CD handles the deploy side. Revisit when the runner becomes a bottleneck or when you want to consolidate everything into K8s.

**However**: if Argo Workflows is adopted, builds happen on the cluster — they can push to Nexus directly without network hops. This makes Phase 3 more attractive with Nexus in the picture. The self-hosted runner droplet ($24/mo) could be decommissioned.

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
