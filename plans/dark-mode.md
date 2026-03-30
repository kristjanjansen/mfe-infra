# Plan: Dark Mode Across Microfrontends

## Goal

All MFE custom elements react to a `data-theme="light"|"dark"` toggle instantly — no flash of wrong theme on initial load, smooth transition on toggle.

## Challenge

Each MFE renders inside a **shadow DOM**. Shadow DOM isolates styles, so:
- CSS on `<html>` or `<body>` doesn't reach into shadow roots
- `data-theme` attributes on the host document are invisible inside shadows
- Each MFE has its own compiled Tailwind CSS injected as a `<style>` element

## Approach: CSS Custom Properties (cascade through shadow DOM)

CSS custom properties are the **one thing that pierces shadow DOM boundaries** by design. They inherit from the host document into shadow roots without any extra wiring.

### How It Works

1. **Host defines theme variables on `:root`:**
   ```css
   :root, :root[data-theme="light"] {
     --color-bg: #ffffff;
     --color-bg-secondary: #f3f4f6;
     --color-text: #111827;
     --color-text-secondary: #6b7280;
     --color-border: #e5e7eb;
     /* ... full palette */
   }

   :root[data-theme="dark"] {
     --color-bg: #0f172a;
     --color-bg-secondary: #1e293b;
     --color-text: #f1f5f9;
     --color-text-secondary: #94a3b8;
     --color-border: #334155;
   }
   ```

2. **Tailwind v4 maps utilities to these variables:**
   In each MFE's `index.css`:
   ```css
   @import "tailwindcss";
   @theme {
     --color-surface: var(--color-bg);
     --color-surface-secondary: var(--color-bg-secondary);
     --color-on-surface: var(--color-text);
     --color-on-surface-secondary: var(--color-text-secondary);
     --color-outline: var(--color-border);
   }
   ```
   This gives MFEs classes like `bg-surface`, `text-on-surface`, `border-outline`.

3. **MFEs use semantic color names** instead of raw Tailwind colors:
   ```jsx
   // Before
   <div className="bg-gray-100 text-gray-900">
   // After
   <div className="bg-surface text-on-surface">
   ```

4. **Toggle flips `data-theme` on `<html>`** — CSS variables update, shadow DOMs inherit instantly.

### Why This Works

- CSS custom properties **inherit into shadow DOM** — this is specced behavior, not a hack
- No JS event bus needed for theme propagation
- No per-MFE theme state or attribute observation
- No flash: variables resolve before first paint
- Transition animation is a single CSS rule on the host: `* { transition: background-color 0.2s, color 0.2s; }`

## No-Flash on Initial Load

The theme must be known **before any rendering**. Two techniques combined:

### 1. Blocking Script in `<head>`

In the host's `index.html`, before any MFE scripts:
```html
<script>
  const theme = localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
</script>
```

This runs synchronously before first paint — no flash.

### 2. CSS Default = Light

The `:root` (no `data-theme`) block defaults to light. Even if the script somehow fails, users see a valid theme.

## Toggle Animation

```css
:root {
  transition: color 0.2s ease, background-color 0.2s ease;
}

/* Optionally scope to only themed properties */
:root * {
  transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}
```

Toggle function:
```typescript
function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
}
```

Optionally broadcast to MFEs if any have JS logic that depends on the theme (e.g., chart colors in canvas):
```typescript
window.dispatchEvent(new CustomEvent("mfe:theme-changed", { detail: { theme: next } }));
```

This event is optional — CSS variables already handle the visual update.

## Shared Theme Definition

Create a shared CSS file that all MFEs import:

```
mfe-frontends/src/styles/
  theme.css     # @theme block mapping CSS vars to Tailwind colors
```

Each MFE's `index.css`:
```css
@import "tailwindcss";
@import "../../styles/theme.css";
```

The host's CSS:
```css
@import "./theme-vars.css";  /* :root light/dark variable definitions */
```

This keeps the palette in one place. MFEs never define colors — they consume semantic tokens.

## Color Token Palette

Semantic names (not tied to light/dark):

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--color-bg` | `#ffffff` | `#0f172a` | Page background |
| `--color-bg-secondary` | `#f3f4f6` | `#1e293b` | Card/section background |
| `--color-bg-tertiary` | `#e5e7eb` | `#334155` | Hover states, wells |
| `--color-text` | `#111827` | `#f1f5f9` | Primary text |
| `--color-text-secondary` | `#6b7280` | `#94a3b8` | Secondary text |
| `--color-border` | `#e5e7eb` | `#334155` | Borders, dividers |
| `--color-accent` | `#2563eb` | `#3b82f6` | Links, active states |
| `--color-accent-text` | `#ffffff` | `#ffffff` | Text on accent |

## Migration Steps

1. Define CSS custom property palette in host (`theme-vars.css`)
2. Create shared `theme.css` with Tailwind `@theme` mappings in mfe-frontends
3. Add the blocking `<script>` to host's `index.html`
4. Import `theme.css` in each MFE's `index.css`
5. Replace hardcoded Tailwind colors (`bg-gray-100`) with semantic tokens (`bg-surface`) across all MFE components
6. Add toggle UI to layout MFE
7. Add transition CSS for smooth toggle animation

## Expo Host

The Expo app loads MFEs in a `<WebView>` (see `App.tsx`). The WebView is just a browser — it has no idea what theme the native app wants. We need to pass the theme from React Native into the WebView before MFEs render.

### The Problem

The blocking `<script>` in `index.html` handles the web host. But in the Expo WebView, there's no shared `localStorage` with the native app, and `prefers-color-scheme` reflects the system setting which may differ from the user's in-app choice.

### The Solution

WebView has `injectedJavaScriptBeforeContentLoaded` — a string of JS that runs **before** the page loads, equivalent to our blocking `<script>`. Use it to set `data-theme`:

```tsx
function WebViewScreen({ url, theme }: { url?: string; theme: string }) {
  return (
    <WebView
      source={{ uri: url }}
      injectedJavaScriptBeforeContentLoaded={`
        document.documentElement.setAttribute("data-theme", "${theme}");
      `}
    />
  );
}
```

In `App.tsx`, read the device theme:
```tsx
import { useColorScheme } from "react-native";

export default function App() {
  const colorScheme = useColorScheme(); // "light" | "dark"
  // ...pass colorScheme to WebViewScreen
}
```

### When Theme Changes at Runtime

If the user toggles theme while the app is open, the WebView needs updating. Use `webViewRef.injectJavaScript()`:

```tsx
const webViewRef = useRef<WebView>(null);

useEffect(() => {
  webViewRef.current?.injectJavaScript(`
    document.documentElement.setAttribute("data-theme", "${theme}");
    true;
  `);
}, [theme]);
```

### Summary of What Changes in Expo Host

1. Add `useColorScheme()` (or a custom theme context) to `App.tsx`
2. Pass theme string to `WebViewScreen`
3. Add `injectedJavaScriptBeforeContentLoaded` to set `data-theme` before page load (no flash)
4. Add `useEffect` + `injectJavaScript` to update theme on runtime toggle
5. Add a `ref` to the `<WebView>` component
