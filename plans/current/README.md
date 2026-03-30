# Current Production System (CSSP)

Analysis of the existing Enefit self-service portal that the MFE system aims to replace/evolve.

## Repositories

| Repo | Purpose | Stack |
|------|---------|-------|
| `cssp-customer-selfservice-portal-ui` | MFE apps (8 modules) | React 18, Vite, TailwindCSS 4, TanStack Query 5, Axios |
| `fmg-6ge-front` | Host shell (legacy) | React 17, Vite, Redux, SCSS, Superagent |
| `cssp-translations` | Translation files | JSON files, Node.js build/verify scripts |
| `cssp-reactnative-poc` | Mobile app (Expo) | React Native 0.79, Expo 53, WebView |

## Architecture

### MFE Composition

CSSP builds 8 independent microfrontends:
- `nav-enefitone` — navigation
- `mandates` — mandate management
- `billing` — billing info
- `usage` — usage data visualization
- `dashboard` — main dashboard
- `pages` — static pages
- `orders` — order management (gas, producer, insurance)
- `customer-data` — customer info management

Each MFE is a separate Vite build (`APP` env var selects which one, same as our `mf-frontends` pattern). The host `fmg-6ge-front` loads them via Vite proxy in dev and HTML injection in production.

### Host (fmg-6ge-front)

The host is a **legacy React 17 app** with Redux, Redux Form, Superagent, and SCSS. It handles:
- Authentication (session-based via `/api/v1/session`)
- Multi-country routing (EE, LV, LT with separate entry points per country)
- Multi-instance support (external, internal, public-products)
- Legacy views that haven't been migrated to MFEs yet
- Shadow DOM encapsulation to prevent CSS conflicts between legacy and MFE styles

### Multi-Country / Multi-Instance

Single codebase serves 3 countries × 3 instances:

| Instance | EE | LV | LT |
|----------|----|----|-----|
| External | iseteenindus.energia.ee | mans.enefit.lv | savitarna.enefit.lt |
| Internal | ee-eservice.enefit.sise | lv-eservice.enefit.sise | lt-eservice.enefit.sise |
| App | Mobile WebView | Mobile WebView | Mobile WebView |

Build scripts: `build-ee-external`, `build-lv-external`, etc. Each produces a separate bundle with country/instance/language baked in via env vars and HTML injection.

### Authentication & Mandates

- Session-based auth (not token-based)
- `/api/v1/session` for session check
- Mandate system: users switch between contexts (business, residential, delegated)
- AuthProvider (React Context + TanStack Query) manages session, customer data, mandates
- Remember-me support for mobile/app instance

### API

- CSSP uses **Axios** with custom BackendClient
- Host uses **Superagent** (different HTTP client)
- v1 endpoints: session, customers, mandates, payments, metering points
- v2 endpoints: bills, usage data, consents
- Demo mode via `/mock-api` toggled by localStorage flag
- Runtime config loaded from `/config.json` (feature flags, environment, country)

### Translations

Separate repo (`cssp-translations`) with:
- JSON files organized by product/country: `translations/{selfservice|app|csr}/{ee|lv|lt}/`
- Format: `{ "key": { "et": "value", "en": "value", "ru": "value" } }`
- Custom verification script validates all keys have all required languages
- Deployed as static files served by nginx
- `publish` branch allows quick translation updates without full CI
- i18next with chained backend (localStorage cache + HTTP fallback)

### Design System

- **CSSP**: Enefit Design System (EDS) v0.8.10 — `@enefit-web/enefit-design-system`
- Tailwind CSS 4 with EDS custom utilities (`p-eds-16`, etc.)
- **Host**: Legacy `enefit-react` component library + SCSS

### Mobile App

Expo 53 + React Native 0.79:
- WebView wrapper around the web MFEs
- Expo Router (file-based routing)
- PDF viewer, biometrics, device info
- Beta and live build configs with separate bundle IDs
- Self-signed certs for local dev

## CI/CD

- **Jenkins** (not GitHub Actions)
- Docker images tagged with build number, pushed to **Nexus** registry
- Sonar integration for code quality
- Separate build and deploy jobs
- Internal NPM registry at `nexus.energia.sise`

## Key Differences from MFE Prototype

| Aspect | Current (CSSP) | MFE Prototype |
|--------|---------------|---------------|
| Host | Legacy React 17 + Redux | Modern React 19 + React Router |
| MFE loading | Vite proxy + HTML injection | Web Components + dynamic script loading |
| Style isolation | Shadow DOM manually in host | Shadow DOM via `registerCustomElement` |
| HTTP client | Axios (CSSP) + Superagent (host) | Fetch (via Nitro) |
| State management | Redux (host) + React Context (MFEs) | React Context + TanStack Query |
| CI/CD | Jenkins + Nexus | GitHub Actions + ghcr.io |
| K8s | Internal infrastructure | OrbStack (local) → DigitalOcean |
| Countries | 3 (EE, LV, LT) × 3 instances | Single instance |
| Auth | Session-based with mandates | None yet |
| Design system | EDS (@enefit-web) | Tailwind defaults |
| Translations | Complex verification + chained backend | Simple JSON merge script |
| Feature flags | Runtime config.json | None yet |
| Testing | Vitest (CSSP) + Jest/Enzyme (host) | None yet |
| Mobile | Expo WebView wrapper | Expo WebView wrapper (similar) |

## What to Carry Forward

Things the current system does well that the MFE plans should account for:

1. **Multi-country/multi-instance** — not in current plans. Need to decide if the new system supports this or starts single-country.
2. **Mandate system** — core business logic, needs auth plan.
3. **Runtime config.json** — feature flags without redeploy. Simple and effective.
4. **Translation verification** — ensures no missing translations per language. Keep this.
5. **Demo mode** — mock API for testing/demos. Useful pattern.
6. **EDS design system** — shared component library across MFEs. Currently imported as npm package from internal Nexus.
7. **HTML injection per country/instance** — GTM, chat widgets, analytics vary by market.
