# Plan: Going Live

## What Is "Live"?

Live is a specific, pinned combination of service versions deployed to a production domain. Not `latest-rel` — exact versions that have been tested together.

```
# live.env
MFE_HOST_WEB=rel-0.2.0
MFE_SHELL=rel-0.1.3
MFE_BILLING=rel-0.3.1
MFE_DASHBOARD=rel-0.2.0
MFE_COOKIEBOT=rel-0.1.0
MFE_API=rel-0.1.5
MFE_TRANSLATIONS=rel-0.0.8
```

This file is the production manifest — the single source of truth for what's live. It lives in `mfe-infra`.

## Current State

- PR previews and release previews exist
- No production environment
- No promotion process
- No production domain

## Production Domain

A dedicated non-wildcard domain for live:

```
app.fachwerk.dev        → mfe-host-web (live)
```

MFE URLs are constructed from `live.env` versions + production domain, same as preview environments but with a fixed `live` namespace instead of `pr-*` / `rel-*`.

## Promotion Flow

### How a Version Gets to Live

```
PR preview (pr-3)
  → merge
  → release preview (rel-0.3.1)
  → test on release preview
  → update live.env: MFE_BILLING=rel-0.3.1
  → commit + push to mfe-infra
  → live deploy workflow runs
```

The promotion is a **commit to `live.env` in mfe-infra**. This is:
- Auditable (git history shows who promoted what and when)
- Reviewable (can require PR review on mfe-infra for live.env changes)
- Reversible (revert the commit to roll back)
- Simple (no special UI or manual GitHub Action triggers)

### The Live Deploy Workflow

Triggered by changes to `live.env` on main:

```yaml
name: Live Deploy

on:
  push:
    branches: [main]
    paths: [live.env]

jobs:
  deploy:
    runs-on: self-hosted  # or DO runner
    steps:
      - uses: actions/checkout@v4

      - name: Validate live.env
        run: |
          # All versions must be rel-*, never pr-* or latest-*
          while IFS='=' read -r key version; do
            [[ "$version" == pr-* ]] && echo "ERROR: $key=$version — PRs not allowed in live" && exit 1
            [[ "$version" == latest-* ]] && echo "ERROR: $key=$version — latest not allowed in live" && exit 1
          done < live.env

      - name: Health-check all release previews
        run: |
          # Verify every pinned version is actually deployed and reachable
          # before promoting to live

      - name: Deploy to live namespace
        run: |
          # For each service in live.env:
          #   resolve version → URL
          #   deploy to 'live' namespace with production domain
```

### Constraints

- `live.env` only accepts `rel-*` versions — enforced by the workflow
- No `latest-rel`, no `pr-*` — every version is explicit
- All services in `live.env` must have a running release preview — the workflow health-checks them before deploying
- The `live` K8s namespace is permanent (not created/deleted like preview namespaces)

## Pre-Live Testing

Testing happens on release previews before promotion. Two levels:

### 1. Individual Release Preview Testing

Each service gets tested when its release preview deploys:
- Unit + browser mode tests run in CI before deploy (already in testing plan)
- Smoke test against the release preview URL

### 2. Integration Testing Before Promotion

Before updating `live.env`, you need to verify the new combination works together. Options:

**Option A: Staging environment** — a second permanent environment (like live but for testing). Its own `staging.env` file in mfe-infra. You update `staging.env` first, test, then copy the versions to `live.env`.

**Option B: Test against release previews directly** — release previews already run the exact same code. If `mfe-host-web` rel-0.2.0's `.env.services` points to `mfe-billing` rel-0.3.1, and that combination works on the preview, it'll work in live.

**Recommendation: Option B** to start. Release previews *are* the staging environment. The host's `.env.services` already pins its dependencies to specific release versions. If the combination works on the release preview, promote it. Add a staging environment later if needed.

### 3. Post-Deploy Smoke Test

After the live deploy workflow runs, a smoke test hits `app.fachwerk.dev`:

```yaml
      - name: Smoke test
        run: |
          # curl app.fachwerk.dev, check MFEs load
          # same smoke test as preview, different URL
```

## Rollback

Revert the `live.env` commit:

```bash
git revert HEAD  # if last commit was the promotion
git push
# live deploy workflow triggers, deploys previous versions
```

Because all previous release previews are still running in their namespaces, rollback is instant — no rebuild needed.

## live.env vs .env.services

| | `.env.services` | `live.env` |
|--|---|---|
| Where | Per service repo | `mfe-infra` |
| Purpose | Declare dependencies for preview deploys | Pin exact versions for production |
| Format | `MFE_API=rel-0.0.1` or `MFE_API=latest-rel` | `MFE_API=rel-0.0.1` only |
| Allows `latest-*` | Yes | No |
| Allows `pr-*` | Yes (for PR previews) | No |
| Triggers | Preview deploy in that service's CI | Live deploy workflow in mfe-infra |

## K8s Setup

The live environment uses a permanent `live` namespace:

```bash
kubectl create namespace live
```

Services are deployed the same way as previews but:
- Namespace is always `live`
- Host is `app.fachwerk.dev` (not wildcard)
- TLS is required (cert-manager with Let's Encrypt)
- Images are pulled from ghcr.io (same as DO release previews)

DNS: A single A record `app.fachwerk.dev` → DO load balancer IP (alongside the `*.mfe.fachwerk.dev` wildcard for previews).

## Migration Steps

1. Create `live.env` in mfe-infra with initial pinned versions
2. Create `live` K8s namespace
3. Add DNS record for `app.fachwerk.dev`
4. Create live deploy workflow (triggered by `live.env` changes)
5. Add validation (no `pr-*`, no `latest-*`, health-check before deploy)
6. Add post-deploy smoke test
7. First live deploy
