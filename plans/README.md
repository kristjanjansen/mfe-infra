# Plans

Suggested execution order:

1. [K8s Provider-Agnostic Setup](k8s-provider-agnostic.md) — rename `mf` → `mfe`, provider config layer, DigitalOcean setup
2. [Frontend Structure](frontend-structure.md) — merge layout + navigation into shell, two-way event bus
3. [Routing](routing.md) — app-wide + app-specific routing with `basename`
4. [Dark Mode](dark-mode.md) — CSS custom properties through shadow DOM, no-flash toggle
5. [Graph & Services](graph-and-services.md) — DAG visualization, `.env.services` redesign, version visibility, data structure cleanup
6. [Testing](testing.md) — Vitest everywhere (unit, browser mode, infra), smoke tests against live previews
7. [Going Live](going-live.md) — production deployment via pinned `live.env` manifest, promotion flow, rollback
