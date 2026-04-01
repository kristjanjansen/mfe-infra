# Plans

Suggested execution order:

1. [K8s Provider-Agnostic Setup](k8s-provider-agnostic.md) — rename `mf` → `mfe`, provider config layer, DigitalOcean setup
2. [API Simplification](api-simplification.md) — replace Nitro with Hono, mock auth endpoints
3. [Frontend Structure](frontend-structure.md) — merge layout + navigation into single layout MFE, two-way event bus
4. [Routing](routing.md) — app-wide + app-specific routing with `basename`
5. [Dark Mode](dark-mode.md) — CSS custom properties through shadow DOM, no-flash toggle
6. [Frontend Performance](frontend-performance.md) — shared dependencies, preloading, bundle optimization
7. [Graph & Services](graph-and-services.md) — DAG visualization, `.env.services` redesign, version visibility, data structure cleanup
8. [Testing](testing.md) — Vitest everywhere (unit, browser mode, infra), smoke tests against live previews
9. [Going Live](going-live.md) — tag-based releases, RC environment, `live.env` promotion via PR, auto-rollback

## CP Feature Parity (simplified/mocked)

Features from the current production system, implemented conceptually in the prototype:

10. [Runtime Config & Feature Flags](cp-runtime-config.md) — per-country config files, `useFeature()` hook, devtools MFE
11. [Auth & Mandates](cp-auth.md) — mock session API, mandate switching via events, AuthGuard
12. [Multi-Country](cp-multi-country.md) — country as runtime config, same build + different config per deployment
13. [Translation Verification](cp-translation-verification.md) — verify script checks all keys exist in all languages

## Cross-Cutting References

Config files: dev in `mfe-host-web/public/config/`, K8s live/RC from `mfe-infra/config/` via ConfigMap. See [cp-runtime-config](cp-runtime-config.md).

Per-country K8s setup (namespaces, DNS, deploy loop) is owned by [going-live](going-live.md). [cp-multi-country](cp-multi-country.md) covers the application-level config and what country affects at runtime.

Event contract across MFEs:

| Event | Direction | Detail | Defined in |
|-------|-----------|--------|------------|
| `mfe:navigate` | MFE → Host | `{ path }` | [frontend-structure](frontend-structure.md) |
| `mfe:route-changed` | Host → MFEs | `{ path }` | [frontend-structure](frontend-structure.md) |
| `mfe:theme-changed` | Host → MFEs | `{ theme }` | [dark-mode](dark-mode.md) |
| `mfe:auth-changed` | Host → MFEs | `{ session }` | [cp-auth](cp-auth.md) |
| `mfe:mandate-changed` | Host → MFEs | `{ mandateId }` | [cp-auth](cp-auth.md) |
| `mfe:config-loaded` | Host → MFEs | `{ config }` | [cp-runtime-config](cp-runtime-config.md) |

Version format: `rel-0.0.2` (dotted) in data/config, `rel-0-0-2` (dashed) in DNS hostnames. Deploy script converts. See [graph-and-services](graph-and-services.md).

## Next

14. [Service Config](service-config.md) — move .env.services into package.json `mfe` field, per-MFE dependency granularity
15. [Argo + Traefik](argo-traefik.md) — GitOps deploys (Argo CD), canary rollouts, Traefik ingress, replace custom deploy scripts
