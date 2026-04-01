# Plan: Argo Stack + Traefik Migration

## Current State

GitHub Actions does everything: build → push ghcr.io → kubectl apply → record deploy event. Custom deploy.sh, nginx ingress, cert-manager, custom DAG dashboard.

## Argo Ecosystem

| Component | What it does | Replaces |
|---|---|---|
| **Argo CD** | GitOps sync — watches git repo, applies manifests to cluster | deploy.sh, kubectl in CI, kubeconfig secret |
| **Argo Rollouts** | Canary/blue-green deploys with automatic rollback | raw K8s Deployments, manual rollback |
| **Argo Workflows** | DAG-based CI pipelines running on K8s | GitHub Actions build/push steps |
| **Argo Events** | Event triggers (GitHub webhook → Argo Workflow) | GitHub Actions webhook triggers |

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

**What GitHub Actions still does:**
- Build Docker image
- Push to ghcr.io
- Update version in manifest file (triggers Argo sync)
- Run tests

**What GitHub Actions stops doing:**
- kubectl apply (Argo CD does this)
- kubeconfig secret (not needed)
- deploy.sh (deleted)
- record-deploy-event (Argo notifications replace this)
- .env.services resolution (moves to Kustomize or Argo CD config)

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

1. Install Argo CD on cluster (`kubectl create namespace argocd && kubectl apply -n argocd -f install.yaml`)
2. Install Traefik (or verify it's already running if cluster came with it)
3. Convert one service (mfe-api) to Argo CD Application + Traefik IngressRoute
4. Verify: push manifest change → Argo syncs → Traefik routes traffic
5. Convert remaining services
6. Update GitHub Actions: remove deploy.sh step, add "update manifest version" step
7. Set up Argo CD notifications (webhook to record deploys, or Slack)
8. Remove: deploy.sh, kubeconfig secret, nginx ingress resources, cert-manager (if Traefik handles ACME)
9. Set up ApplicationSet for preview environments
10. (Phase 2) Convert live Deployments to Argo Rollouts
