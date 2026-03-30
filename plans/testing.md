# Plan: Testing Strategy

## Current State

No tests exist anywhere — no test scripts, no test configs, no test dependencies, no test files across any of the repos.

## Testing Layers

Three distinct layers, each catching different problems:

### 1. Unit / Component Tests (per MFE)

**What:** Test individual React components and utilities in isolation.

**Tool:** Vitest — already using Vite for builds, zero extra config, fast.

**Where:** Co-located with source files: `BillingApp.test.tsx` next to `BillingApp.tsx`.

**What to test:**

Shared utilities (test once in `src/utils/`):
- `registerCustomElement()` — mounts, unmounts, handles `base-path` attribute
- Window event dispatch/listen (`mfe:navigate`, `mfe:route-changed`, `mfe:theme-changed`)
- React Query wrapper / fetch helpers — loading states, error states
- Translation hook — namespace scoping, language switching

Per-MFE (only app-specific logic):
- Billing: renders correct line items from API data
- Dashboard: renders correct summary from API data
- Shell: renders nav items, highlights active route

**Setup per MFE repo:**
```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
  },
});
```

```json
// package.json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

### 2. Integration Tests (cross-MFE)

**What:** Test that MFEs load correctly, communicate via events, and render in shadow DOM — in a real browser.

**Tool:** Vitest browser mode with Playwright provider. Same `describe`/`it`/`expect` API as unit tests, but executes in a real browser with real shadow DOM, custom elements, and CSS.

**Where:** `mfe-frontends/src/**/*.browser.test.tsx` and `mfe-host-web/src/**/*.browser.test.tsx`.

**What to test:**
- Custom element mounts in real shadow DOM and renders React content
- CSS custom properties (dark mode) inherit through shadow DOM boundary
- Event dispatch/listen on `window` works between two custom elements on the same page
- `base-path` attribute updates propagate to React Router inside MFE
- Navigation events work: click nav item → route changes → correct MFE renders in content slot
- Dark mode toggle propagates CSS variables into all shadow roots
- Deep linking works (`/orders/order/1` renders correct MFE sub-route)

**Setup:**

```bash
npm install -D @vitest/browser playwright
```

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests: jsdom (fast)
    environment: "jsdom",
    // Browser tests: *.browser.test.* files run in real Chromium
    browser: {
      enabled: true,
      provider: "playwright",
      instances: [{ browser: "chromium" }],
    },
  },
});
```

**Example:**
```typescript
// registerCustomElement.browser.test.tsx
import { expect, test } from "vitest";

test("custom element mounts in shadow DOM and inherits CSS variables", async () => {
  document.documentElement.style.setProperty("--color-bg", "#0f172a");

  const el = document.createElement("mfe-test");
  document.body.appendChild(el);

  const shadow = el.shadowRoot!;
  const computed = getComputedStyle(shadow.querySelector(".root")!);
  expect(computed.backgroundColor).toBe("rgb(15, 23, 42)");
});
```

### 3. Infrastructure Tests

**What:** Test that the deploy pipeline, `.env.services` resolution, K8s manifests, and graph generation work correctly.

**Tool:** Vitest — same tool as the rest of the project. Works fine for pure Node tests (no browser mode needed), keeps the test runner consistent everywhere.

**Where:** `mfe-infra/tests/` directory.

**What to test:**

**a) .env.services resolution:**
- `MFE_BILLING=pr-3` + `DOMAIN=localtest.me` → correct URL
- `MFE_API=latest-rel` resolves to highest semver namespace
- `MFE_API=latest-pr` resolves to highest PR number
- Release deploy fails if any dep resolves to `pr-*`
- Invalid entries are rejected

**b) K8s manifest generation:**
- `envsubst` on base templates produces valid YAML
- Service name, image, port, host are substituted correctly
- TLS variant includes cert-manager annotations

**c) Event recording and aggregation:**
- `record.mjs` produces valid event JSON with resolved versions
- `aggregate-datasets.mjs` deduplicates nodes correctly (DAG, not tree)
- Snapshot generation produces correct state per event
- Edge list has no duplicates

**d) Deploy script logic:**
- Provider config is sourced correctly
- Registry push is conditional on REGISTRY being set
- Namespace naming follows convention

```bash
npm install -D vitest
```

```json
// package.json
"scripts": {
  "test": "vitest run"
}
```

## CI Integration

### Per-MFE PR Workflow

Add test steps before the existing deploy-preview step:

```yaml
# In pr-preview.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm test
  deploy:
    needs: test               # deploy only if tests pass
    runs-on: self-hosted
    # ... existing deploy steps
```

### Smoke Tests Against Live Preview

Vitest browser mode tests components in isolation — it can't catch real-world issues like MFE scripts failing to load from a URL, CORS between subdomains, or network problems with translations/API services.

A lightweight smoke test against the live preview catches those. Not a full test suite — just verify the page loads and key custom elements render:

```yaml
jobs:
  deploy:
    # ... deploy preview, outputs preview_url
  smoke:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:smoke
        env:
          BASE_URL: ${{ needs.deploy.outputs.preview_url }}
```

```typescript
// smoke.browser.test.ts
import { expect, test } from "vitest";
import { page } from "@vitest/browser/context";

test("preview loads and mounts MFEs", async () => {
  await page.goto(process.env.BASE_URL!);
  await expect.element(page.getByRole("navigation")).toBeVisible();
  await expect.element(page.locator("mfe-layout")).toBeVisible();
  await expect.element(page.locator("mfe-dashboard")).toBeVisible();
});
```

Runs only on host-web PRs, after deploy.

### Infra Tests

Run on every push to `mfe-infra`:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
```

## What NOT to Test

- Tailwind class rendering — trust the framework
- Vite build output — if it builds, it works
- Third-party library behavior (React Query caching, i18next parsing)
- Kubernetes API behavior — test your manifests, not K8s itself

## Migration Steps

1. Add Vitest + testing-library to `mfe-frontends`, write unit tests for `registerCustomElement` and event utilities
2. Add Vitest browser mode tests in `mfe-frontends` for shadow DOM, CSS variable inheritance, and cross-element events
3. Add component tests for each MFE app (billing, dashboard, shell)
4. Add Vitest to `mfe-infra`, write tests for `.env.services` resolution, aggregation logic, and DAG deduplication
5. Add Vitest browser mode tests in `mfe-host-web` for full composition (routing, navigation, dark mode)
6. Add test steps to PR workflows (unit + browser mode tests gate deploys)
