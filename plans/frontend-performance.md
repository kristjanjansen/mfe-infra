# Plan: Frontend Performance Optimizations

## Problems

### 1. Duplicated Dependencies

Every MFE bundles its own copy of React, React DOM, React Query, i18next. A page with 3 MFEs loads React three times.

Current per-MFE bundle includes:
- React + React DOM (~45KB gzipped)
- TanStack Query (~15KB gzipped)
- i18next + react-i18next (~15KB gzipped)

With 5 MFEs on a page: ~375KB of duplicated framework code.

### 2. Waterfall Loading

MFEs load sequentially:
1. Host HTML loads
2. Host JS loads
3. Host fetches config
4. Host creates `<mfe-layout>` element
5. Shell script loads (dynamic `<script>` injection)
6. Shell renders, creates slots
7. Content MFE script loads
8. Content MFE renders, fetches API data

Each step waits for the previous one. The content MFE can't start loading until the host has rendered.

### 3. No Preloading

MFE scripts are loaded on demand when the custom element is created. Navigating to `/billing` triggers a fresh script load for `mfe-billing`. No prefetching of likely next routes.

## Changes

### 1. Import Maps for Shared Dependencies

Use the browser's native import maps to deduplicate shared packages. All MFEs import from the same URLs:

Bundle shared deps once in the host and serve from the same origin. No external CDN dependency.

```
mfe-host-web/public/vendor/
  react.js          ← react + react-dom + jsx-runtime
  tanstack-query.js
  i18next.js        ← i18next + react-i18next
```

Build with a separate Vite config in the host:

```typescript
// vite.config.vendor.ts
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        react: "vendor/react-entry.js",
        "tanstack-query": "vendor/tanstack-query-entry.js",
        i18next: "vendor/i18next-entry.js",
      },
      output: { dir: "public/vendor", format: "es", entryFileNames: "[name].js" },
    },
    emptyOutDir: false,
  },
});
// npm run build:vendor → vite build -c vite.config.vendor.ts
```

Import map in host's `index.html` points to self-hosted files:

```html
<script type="importmap">
{
  "imports": {
    "react": "/vendor/react.js",
    "react-dom/client": "/vendor/react.js",
    "react/jsx-runtime": "/vendor/react.js",
    "@tanstack/react-query": "/vendor/tanstack-query.js",
    "i18next": "/vendor/i18next.js",
    "react-i18next": "/vendor/i18next.js"
  }
}
</script>
```

Each MFE's Vite config marks these as external:

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["react", "react-dom/client", "react/jsx-runtime",
                 "@tanstack/react-query", "i18next", "react-i18next"],
    },
  },
});
```

Result: shared packages load once from the host, cached by the browser. MFE bundles contain only app code. No external CDN, no CORS, same origin, works offline.

### 2. Preload MFE Scripts

The deploy script knows all MFE URLs (from `.env.services`). Inject `<link rel="modulepreload">` into the host's `index.html` at deploy time so the browser starts fetching before the host JS even runs:

```html
<!-- Always preload layout (needed on every page) + vendor bundles -->
<link rel="modulepreload" href="/vendor/react.js" />
<link rel="modulepreload" href="https://mfe-layout-rel-0-1-3.mfe.fachwerk.dev/index.js" />
```

Route MFEs (billing, dashboard) are prefetched on idle instead — see section 3. No need to preload all of them upfront.

### 3. Prefetch All Route MFEs on Idle

After initial render, prefetch all route MFEs in the background. No hover detection needed — there are only 2-3 route MFEs and they're small once shared deps are extracted.

```typescript
// In host, after initial render
requestIdleCallback(() => {
  Object.values(mfs)
    .filter(m => m.route)
    .forEach(m => {
      const link = document.createElement("link");
      link.rel = "modulepreload";
      link.href = getMfeUrl(m);
      document.head.appendChild(link);
    });
});
```

Result: by the time the user clicks a nav item, the MFE script is already cached. Instant route transitions.

### 4. Lazy Load Non-Critical MFEs

Not all MFEs need to load immediately:
- **Critical (load immediately):** layout, current route's MFE
- **Deferred (load after first render):** cookiebot, devtools
- **Prefetched (load on idle):** other route MFEs

The host controls loading order:

```typescript
// Load critical MFEs first
await loadMfeScript(mfs.layout);
await loadMfeScript(mfs[currentRoute]);

// Defer non-critical
requestIdleCallback(() => {
  loadMfeScript(mfs.cookiebot);
  loadMfeScript(mfs.devtools);
});
```

### 5. CSS Loading Optimization

Currently each MFE injects CSS as a `<style>` element inside shadow DOM. This is fine but the CSS is embedded in the JS bundle (via `?inline` import).

Alternative: Load CSS separately so the browser can cache it independently:

```typescript
// In registerCustomElement, fetch CSS as a separate file
const cssResponse = await fetch(`${baseUrl}/index.css`);
const cssText = await cssResponse.text();
const style = document.createElement("style");
style.textContent = cssText;
shadow.prepend(style);
```

Benefits:
- CSS cached separately from JS (smaller JS bundles)
- CSS can be preloaded via `<link rel="preload">`
- CSS updates don't invalidate JS cache

### 6. Shared QueryClient

Currently each MFE creates its own TanStack Query client. API responses fetched by one MFE aren't shared with another.

With import maps (shared `@tanstack/react-query`), all MFEs can share a single QueryClient instance:

```typescript
// Host creates the QueryClient
window.__MFE_QUERY_CLIENT__ = new QueryClient();

// Each MFE uses it
function App() {
  return (
    <QueryClientProvider client={window.__MFE_QUERY_CLIENT__}>
      {/* ... */}
    </QueryClientProvider>
  );
}
```

Benefits:
- API response deduplication (billing and dashboard both fetch from `/api/v2/bills` — only one request)
- Shared cache invalidation on mandate switch (`queryClient.invalidateQueries()` clears everything)

## Impact Estimate

| Optimization | Effort | Transfer saved | Speed improvement |
|-------------|--------|----------------|------------------|
| Import maps (shared deps) | Medium | ~300KB gzipped | Initial load ~1-2s faster on 3G, ~200-400ms on 4G |
| Preload layout + vendor | Low | 0 (same bytes, earlier) | First paint ~300-500ms faster (eliminates waterfall) |
| Prefetch route MFEs on idle | Low | 0 (same bytes, earlier) | Route navigation ~200-500ms → near-instant |
| Lazy load non-critical | Low | ~50-100KB deferred | First interactive ~100-200ms faster |
| Separate CSS loading | Low | 0 (better caching) | Repeat visits ~50-100ms faster |
| Shared QueryClient | Low | Fewer API calls | ~100-200ms per deduplicated request |

**Combined estimate:** Initial load ~1.5-3s faster on slow connections. Route transitions near-instant. Repeat visits benefit from granular caching.

## Migration Steps

1. Add import map to host's `index.html` with shared deps (self-hosted or esm.sh)
2. Mark shared deps as external in MFE Vite configs
3. Add `<link rel="modulepreload">` for critical MFE scripts
4. Add idle prefetching for non-critical route MFEs
5. Move QueryClient to host, expose as global
6. Defer cookiebot/devtools loading to `requestIdleCallback`
