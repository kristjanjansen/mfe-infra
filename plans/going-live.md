# Plan: Going Live

## What Is "Live"?

Live is a specific, pinned combination of service versions deployed to a production domain. Not `latest-rel` — exact versions that have been tested together.

```
# live.env
MFE_HOST_WEB=rel-0.2.0
MFE_LAYOUT=rel-0.1.3
MFE_BILLING=rel-0.3.1
MFE_DASHBOARD=rel-0.2.0
MFE_COOKIEBOT=rel-0.1.0
MFE_API=rel-0.1.5
MFE_TRANSLATIONS=rel-0.0.8
```

This file is the production manifest — the single source of truth for what's live. It lives in `mfe-infra`.

## Current State

- PR previews and release previews exist
- Release previews are triggered by a special PR title convention (`RELEASE 1.2.3`) — a manual naming step
- No production environment, no promotion process, no production domain
- No automated release flow

## Remove Manual Steps from Current Workflow

The current `pr-preview.yml` scans the PR title for `RELEASE x.y.z` to decide if it's a release. This is fragile (typo in title = no release) and manual.

Replace with: **releases triggered by git tags**, not PR titles.

```yaml
# In each service repo
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  release:
    uses: kristjanjansen/mfe-infra/.github/workflows/release-preview.yml@main
    with:
      service_name: mfe-billing
      port: "4000"
      version: ${{ github.ref_name }}  # e.g., v0.3.1
```

Flow becomes:
```
git tag v0.3.1 && git push --tags
  → release-preview.yml runs
  → mfe-billing-rel-0-3-1 deployed
```

No special PR titles. `pr-preview.yml` handles PRs only. `release-preview.yml` handles tags only. Clean separation.

Remove the `RELEASE` title scanning from `pr-preview.yml` — PRs are always `pr-*`, releases are always tag-triggered.

## Production Domain

Two permanent environments:

```
rc.fachwerk.dev         → release candidate (testing before live)
app.fachwerk.dev        → live (production)
```

Both use pinned versions from `live.env`. RC gets them first for testing, live gets them after.

## Promotion Flow

### The Full Pipeline

```
1. git tag v0.3.1 && git push --tags
   → release preview deploys (mfe-billing-rel-0-3-1.mfe.fachwerk.dev)

2. Update live.env in a PR on mfe-infra:
     MFE_BILLING=rel-0.3.1
   → PR triggers RC deploy to rc.fachwerk.dev

3. Tests run against rc.fachwerk.dev automatically
   → If tests fail: fix and update PR
   → If tests pass: merge PR

4. Merge triggers live deploy to app.fachwerk.dev

5. Post-deploy smoke test on app.fachwerk.dev
   → If smoke fails: auto-revert commit, redeploy previous versions
```

### Why a PR (Not Direct Push)

The promotion to live goes through a PR on mfe-infra:
- **RC deploys on PR open/update** — tests the exact combination before merge
- **Live deploys on merge to main** — human approval gate (PR review + merge)
- **Auditable** — git history shows who promoted what and when
- **Reversible** — revert the merge commit to roll back

### The RC + Live Deploy Workflow

```yaml
name: Deploy

on:
  pull_request:
    paths: [live.env]
  push:
    branches: [main]
    paths: [live.env]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate live.env
        run: |
          while IFS='=' read -r key version; do
            [[ -z "$key" || "$key" =~ ^# ]] && continue
            [[ "$version" == pr-* ]] && echo "ERROR: $key=$version" && exit 1
            [[ "$version" == latest-* ]] && echo "ERROR: $key=$version" && exit 1
          done < live.env

  deploy-rc:
    if: github.event_name == 'pull_request'
    needs: validate
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to RC (all countries)
        run: |
          # For each config/{country}.json:
          #   deploy all services from live.env to rc-{country} namespace
          #   mount config/{country}.json as ConfigMap

      - name: Test against RC
        run: |
          # Run smoke + integration tests against rc.fachwerk.dev
          # (see Health Checks section below)

  deploy-live:
    if: github.event_name == 'push'
    needs: validate
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to live (all countries)
        run: |
          # For each config/{country}.json:
          #   deploy all services from live.env to live-{country} namespace
          #   mount config/{country}.json as ConfigMap

      - name: Smoke test
        id: smoke
        continue-on-error: true
        run: |
          # Quick health check on ee.app.fachwerk.dev (and lv, lt)

      - name: Auto-rollback on failure
        if: steps.smoke.outcome == 'failure'
        run: |
          git revert HEAD --no-edit
          git push
          # This triggers another deploy with previous versions
```

## Health Checks

### What "Health Check" Means

Three levels, each progressively deeper:

**1. HTTP reachability** — can we reach each service?
```bash
# For each service in live.env, resolve URL and check HTTP 200
for service_url in $RESOLVED_URLS; do
  curl --fail --max-time 10 "$service_url" \
    || exit 1
done
```

Catches: service not deployed, namespace missing, DNS broken, image crash loop.

**2. Asset loading** — do MFE bundles load?
```bash
# Each MFE serves index.js and index.css
curl --fail "$service_url/index.js" > /dev/null
curl --fail "$service_url/index.css" > /dev/null
```

Catches: broken build, missing files, wrong build output.

**3. Integration smoke test** — does the composed app work?

Vitest browser mode test against the target domain (RC or live):

```typescript
// smoke.browser.test.ts
import { expect, test } from "vitest";
import { page } from "@vitest/browser/context";

const BASE = process.env.BASE_URL; // rc.fachwerk.dev or app.fachwerk.dev

test("app loads and mounts all MFEs", async () => {
  await page.goto(BASE);
  await expect.element(page.locator("mfe-layout")).toBeVisible();
  await expect.element(page.locator("mfe-dashboard")).toBeVisible();
});

test("navigation works", async () => {
  await page.goto(BASE);
  await page.locator("mfe-layout").getByText("Billing").click();
  await expect.element(page.locator("mfe-billing")).toBeVisible();
});

test("API data loads", async () => {
  await page.goto(`${BASE}/billing`);
  // Verify billing data renders (not just the shell)
  await expect.element(page.locator("mfe-billing").getByRole("table")).toBeVisible();
});
```

Catches: cross-origin issues, event bus broken, MFE version mismatch, API unreachable.

### When Each Level Runs

| Check | RC deploy | Live deploy |
|-------|-----------|-------------|
| HTTP reachability | Yes | Yes |
| Asset loading | Yes | Yes |
| Integration smoke | Yes (full suite) | Yes (quick subset) |

RC gets the full test suite (takes longer, that's fine — it's pre-merge). Live gets a quick smoke (fast, post-deploy, triggers rollback on failure).

## Rollback

### Automatic (smoke test failure)

The live deploy workflow auto-reverts on smoke failure:
```
Deploy → smoke fails → git revert → push → redeploy previous versions
```

Previous release preview namespaces are still running — rollback doesn't need to rebuild anything, just re-deploy from existing images.

### Manual

```bash
git revert HEAD
git push
# live deploy workflow triggers with previous versions
```

Or update `live.env` to specific older versions and push.

## live.env vs .env.services

| | `.env.services` | `live.env` |
|--|---|---|
| Where | Per service repo | `mfe-infra` |
| Purpose | Declare dependencies for preview deploys | Pin exact versions for production |
| Format | `MFE_API=rel-0.0.1` or `MFE_API=latest-rel` | `MFE_API=rel-0.0.1` only |
| Allows `latest-*` | Yes | No |
| Allows `pr-*` | Yes (for PR previews) | No |
| Triggers | Preview deploy in that service's CI | RC deploy (on PR) / live deploy (on merge) |

## K8s Setup

### Per-Country Namespaces

Live and RC each get one namespace per country:

```bash
# Live
kubectl create namespace live-ee
kubectl create namespace live-lv
kubectl create namespace live-lt

# RC
kubectl create namespace rc-ee
kubectl create namespace rc-lv
kubectl create namespace rc-lt
```

Each namespace gets:
- Same MFE images (from `live.env` versions)
- Country-specific `config.json` mounted as K8s ConfigMap
- Country-specific ingress/domain

### ConfigMaps

Per-country config mounted into the host container as `/config.json`:

```bash
kubectl create configmap country-config \
  --from-file=config.json=config/ee.json \
  -n live-ee
```

### DNS

```bash
# Live (per country)
doctl compute domain records create fachwerk.dev --record-type A --record-name "ee.app" --record-data "$LB_IP"
doctl compute domain records create fachwerk.dev --record-type A --record-name "lv.app" --record-data "$LB_IP"
doctl compute domain records create fachwerk.dev --record-type A --record-name "lt.app" --record-data "$LB_IP"

# RC (per country)
doctl compute domain records create fachwerk.dev --record-type A --record-name "rc-ee" --record-data "$LB_IP"
doctl compute domain records create fachwerk.dev --record-type A --record-name "rc-lv" --record-data "$LB_IP"
doctl compute domain records create fachwerk.dev --record-type A --record-name "rc-lt" --record-data "$LB_IP"

# Previews (single wildcard, single country)
# *.mfe.fachwerk.dev already exists
```

### Deploy Flow

The workflow loops over countries:

```bash
for country in ee lv lt; do
  NAMESPACE="live-${country}"
  HOST="${country}.app.fachwerk.dev"
  CONFIG="config/${country}.json"

  # Update ConfigMap
  kubectl create configmap country-config \
    --from-file=config.json="$CONFIG" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

  # Deploy all services from live.env
  for service in $(parse_live_env); do
    deploy "$service" "$NAMESPACE" "$HOST"
  done
done
```

### Previews: Single Country

Previews stay simple — one namespace, one country (EE by default). No per-country preview URLs. Shell has a dev-only country selector dropdown for testing other countries.

### TLS

- cert-manager with Let's Encrypt (from k8s-provider-agnostic plan)
- Separate certs per domain: `ee.app.fachwerk.dev`, `lv.app.fachwerk.dev`, `lt.app.fachwerk.dev`
- Or a SAN cert covering all three

## Migration Steps

1. Replace `RELEASE` PR title convention with tag-triggered releases in each repo
2. Remove release title scanning from `pr-preview.yml`
3. Create `live.env` in mfe-infra with initial pinned versions
4. Create `config/ee.json` (start with one country)
5. Create per-country K8s namespaces (`live-ee`, `rc-ee`)
6. Add DNS records for `ee.app.fachwerk.dev` and `rc-ee.fachwerk.dev`
7. Create the combined RC + live deploy workflow with country loop
8. Add health checks (HTTP + asset + smoke test per country)
9. Add auto-rollback on live smoke failure
10. First RC deploy via PR, first live deploy via merge
11. Add LV and LT when ready (add config JSON + namespace + DNS)
