# mf-infra

Microfrontends infrastructure.

## Demo

https://kristjanjansen.github.io/mf-infra/

## Links to repos

https://github.com/kristjanjansen/mf-host-web

https://github.com/kristjanjansen/mf-host-expo

https://github.com/kristjanjansen/mf-frontends

https://github.com/kristjanjansen/mf-api

https://github.com/kristjanjansen/mf-translations

## Overview

Centralized infrastructure for **multi-repo PR preview environments**.

This repo provides:

- Preview and release deployment logic
- Reusable GitHub Actions
- Shared Kubernetes base manifests (deployment, service, ingress)
- Local action runner via self-hosted Github Actions runner and OrbStack Kubernetes

## Create PR preview

Add `Dockerfile` to your service that exposes port `4000` or similar.

Then add `.github/workflows/pr-preview.yml`:

```yml
name: PR Preview

on:
  pull_request:
    types: [opened, reopened, synchronize, closed]

jobs:
  preview:
    uses: kristjanjansen/mf-infra/.github/workflows/pr-preview.yml@main
    with:
      service_name: my-service
      port: 4000
    secrets:
      infra_token: ${{ secrets.INFRA_TOKEN }}
```

When creating pull requires with id of `123`, your service will now be available at `https://my-service-pr-123.localtest.me`.

## Create release preview

Then add `.github/workflows/release-preview.yml`:

```yml
name: Release Preview

on:
  workflow_dispatch:
    inputs:
      version:
        description: "Release version"
        required: true
        type: string

jobs:
  release_preview:
    uses: kristjanjansen/mf-infra/.github/workflows/release-preview.yml@main
    with:
      service_name: mf-api
      port: 4000
      version: ${{ inputs.version }}
    secrets:
      infra_token: ${{ secrets.INFRA_TOKEN }}
```

You will manually run the workflow in Github entering version number like `1.2.3` After running the preview will be available at `https://my-service-rel-1-2-3.localtest.me`.

## Deploy event recording

Deploy workflows call the composite action `record-deploy-event`, which commits a single JSON file per run into `events/YYYY/MM/DD/...`.

The `Aggregate datasets` workflow is triggered by pushes to `events/**` and debounces bursts before regenerating `datasets/events.json` and `datasets/deps.json`.

## Local setup on Mac

Install OrbStack:

```bash
brew install orbstack kubectl
```

Run OrbStack:

```bash
orb
```

Verify cluster readiness:

```bash
kubectl get nodes
```

Expected output:

```
orbstack   Ready   control-plane,master   ...
```

### Install NGINX Ingress Controller

Run:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/baremetal/deploy.yaml
```

Check status:

```bash
kubectl get pods -n ingress-nginx
```

Ingress routing is now enabled for `*.localtest.me` hostnames.

### Set Up a Self-Hosted GitHub Runner

Go to:

> GitHub → Repo → Settings → Actions → Runners → New self-hosted runner

Follow the instructions on each repo that has a preview workflow.

### Set Github Actions Permissions

Go to:

> GitHub → Repo → Settings → Actions → General → Workflow permissions

Select "Read and write permissions".

## Dashboard

This repo generates:

- `datasets/events.json` (aggregated deploy events)
- `datasets/deps.json` (dependency tree for the dashboard)

The dashboard is served from `index.html` and loads `./datasets/deps.json`.
