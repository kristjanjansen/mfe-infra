# Plan: Frontend Structure — Merge Layout + Navigation, Unified MFE Communication

## Goal

1. Merge `mfe-layout` and `mfe-navigation` into a single `mfe-layout` microfrontend
2. Replace the current mixed communication pattern (events up, attributes down) with a consistent two-way event bus

## Current State

### Layout + Navigation

`mfe-layout` is a shadow DOM component with two slots (`navigation`, `content`). `mfe-navigation` is a separate MFE slotted into layout. They have no direct relationship — the host orchestrates them.

This split adds complexity without benefit: layout has no logic (just a `<main>` with two slots), and navigation always lives inside layout. They're always deployed together and never used independently.

### Communication Pattern (asymmetric)

```
Navigation -> Host:  CustomEvent "mf:navigate" (bubbles up)
Host -> Navigation:  setAttribute("current-path", ...)
```

The host acts as a mediator: it listens to `mf:navigate` events from navigation, calls React Router's `navigate()`, then pushes the new path back down as an HTML attribute. This works but:
- Attributes are one-way and string-only (no complex data)
- Navigation needs a special `registerNavigationElement()` + `MfNavigation` wrapper in the host, while all other MFEs use the generic `registerCustomElement()` + `MfElement`
- Any new MFE that needs to know the current path would need the same special attribute wiring

## Changes

### 1. Merge Layout + Navigation into `mfe-layout`

Combine into `src/apps/mfe-layout/`:
- Shell renders the sidebar navigation and the slot-based content area
- One shadow DOM component, one custom element `<mfe-layout>`
- Eliminates the `navigation` slot — only `content` slot remains
- Layout CSS and navigation CSS merge into one

Host simplifies to:
```jsx
<MfElement mf={mfs.layout}>
  <Routes>
    <Route path="/" element={<Navigate to="/dashboard" replace />} />
    {routeMfs.map((r) => (
      <Route key={r.path} path={r.path} element={<MfElement mf={r} slot="content" />} />
    ))}
  </Routes>
</MfElement>
```

Remove from config: `layout` and `navigation` entries. Add: `layout`.

### 2. Two-Way Event Bus for MFE Communication

Replace attributes + events with a symmetric event pattern using `window` as the bus:

**Events emitted by MFEs (up):**
```typescript
window.dispatchEvent(new CustomEvent("mfe:navigate", {
  detail: { path: "/billing" }
}));
```

**Events emitted by host (down):**
```typescript
window.dispatchEvent(new CustomEvent("mfe:route-changed", {
  detail: { path: "/billing" }
}));
```

**Any MFE listens:**
```typescript
window.addEventListener("mfe:route-changed", (e) => {
  const { path } = (e as CustomEvent).detail;
  // update active state, breadcrumbs, etc.
});
```

### Event Contract

| Event | Direction | Detail | Purpose |
|-------|-----------|--------|---------|
| `mfe:navigate` | MFE -> Host | `{ path: string }` | Request navigation |
| `mfe:route-changed` | Host -> MFEs | `{ path: string }` | Notify all MFEs of current route |

This is symmetric, decoupled, and extensible:
- Any MFE can listen to `mfe:route-changed` without special host wiring
- Any MFE can request navigation without a dedicated wrapper component
- Future events (e.g. `mfe:locale-changed`, `mfe:auth-changed`) follow the same pattern
- No attributes, no `observedAttributes`, no `attributeChangedCallback`

### 3. Simplify Registration

With the event bus, `registerNavigationElement()` is no longer needed. All MFEs (including layout) use `registerCustomElement()`. The `MfNavigation` wrapper in the host is replaced by the generic `MfElement`.

## Migration Steps

1. Create `src/apps/mfe-layout/` combining layout + navigation code and styles
2. Wire layout to emit `mfe:navigate` and listen to `mfe:route-changed` using raw `window.dispatchEvent` / `window.addEventListener`
3. Update host to dispatch `mfe:route-changed` on route changes (single `useEffect` in App)
4. Update host to listen to `mfe:navigate` on window (single `useEffect` in App)
6. Remove `MfNavigation` component from host — layout uses generic `MfElement`
7. Remove `registerNavigationElement()` from utils
8. Delete `src/apps/mfe-layout/` and `src/apps/mfe-navigation/`
9. Update config, env vars, Dockerfiles, and GitHub Actions

## Future Extensions

The event bus pattern naturally supports:
- `mfe:locale-changed` — broadcast language switch to all MFEs
- `mfe:auth-changed` — broadcast auth state changes
- `mfe:theme-changed` — broadcast theme preference
- `mfe:error` — MFEs report errors to host for centralized handling
