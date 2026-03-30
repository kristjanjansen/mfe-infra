# Plan: Runtime Config & Feature Flags

## What CP Does

Loads `/config.json` at runtime containing environment, country, instance, and `FEATURE_*` flags. Enables toggling features without redeploy.

## Simplified Version for MFE Prototype

### Config Files

Per-country JSON files served as static files by the host's nginx:

```
mfe-host-web/public/config/
  ee.json
  lv.json
  lt.json
```

```json
// config/ee.json
{
  "environment": "dev",
  "country": "EE",
  "defaultLanguage": "et",
  "languages": ["et", "en"],
  "features": {
    "orders": true,
    "orders.gas": false,
    "darkMode": true
  }
}
```

No `config.json` at the root — avoids keeping a duplicate in sync with `ee.json`. The host fetches the right country file directly.

Note: no service URLs here. API, translations, and MFE URLs are injected as env vars by the deploy script (from `live.env` / `.env.services`) and accessed via `import.meta.env.MFE_*`. Config only has application-level settings.

### Loading

The host fetches config by country before mounting any MFEs:

```typescript
// In host, before React renders
const country = localStorage.getItem("configCountry") || "ee";
const config = await fetch(`/config/${country}.json`).then(r => r.json());
window.__MFE_CONFIG__ = config;
```

Default is `ee`. The config switcher MFE (see below) can change the country.

### Accessing Config in MFEs

MFEs read from the global:

```typescript
function useConfig() {
  return window.__MFE_CONFIG__;
}

function useFeature(flag: string): boolean {
  const config = useConfig();
  return config?.features?.[flag] ?? false;
}
```

### Feature Flags in the Shell

The shell can conditionally render nav items based on features:

```typescript
const navItems = [
  { path: "/dashboard", label: "Dashboard" },
  { path: "/billing", label: "Billing" },
  useFeature("orders") && { path: "/orders", label: "Orders" },
].filter(Boolean);
```

### Config Switcher MFE

A small non-routed MFE (`mfe-devtools`) — same pattern as cookiebot. Overlay UI, always present in non-live environments. Lets you:

- Switch country (EE / LV / LT)
- Toggle feature flags
- View current config

```typescript
// Host loads it conditionally
if (config.environment !== "live") {
  <MfElement mf={mfs.devtools} />
}
```

On country switch:
```typescript
localStorage.setItem("configCountry", "lv");
window.location.reload();
```

On feature flag toggle:
```typescript
const config = window.__MFE_CONFIG__;
config.features["orders.gas"] = true;
localStorage.setItem("configOverride", JSON.stringify(config.features));
window.location.reload();
```

Host checks for feature overrides on startup:
```typescript
const config = await fetch(`/config/${country}.json`).then(r => r.json());
const featureOverride = localStorage.getItem("configOverride");
if (featureOverride) {
  config.features = { ...config.features, ...JSON.parse(featureOverride) };
}
window.__MFE_CONFIG__ = config;
```

Clear overrides = reset to default config for that country.

### Where Config Files Live

| Environment | Source | How |
|-------------|--------|-----|
| Local dev | `mfe-host-web/public/config/ee.json` | Committed to repo, all countries available |
| Previews | Same static files from Docker image | Default EE, switcher available |
| Live / RC | `mfe-infra/config/{country}.json` | Mounted as K8s ConfigMap into `/config/` directory |

In K8s live, only the relevant country file is mounted. The switcher MFE is not loaded (environment is `"live"`).

### TODO: Revisit Later

- Country switching via localStorage + devtools MFE (currently hardcoded to ee.json)
- Feature flag overrides via localStorage
- Config switcher MFE (`mfe-devtools`)

### What to Skip

- Config as an API endpoint (not needed — static files work)
- Per-user feature flags
- A/B testing
- Config hot-reload (page refresh is fine)
