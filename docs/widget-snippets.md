# Embedding the ContextLayer widget

The widget is a single JS bundle hosted on a CDN. Add the
`contextlayer-api-key` meta tag to your site's `<head>` and
the snippet below where you want the widget to mount.

> SRI is mandatory. Loading the script without the integrity
> attribute exposes your visitors to a CDN compromise. The hash
> below is regenerated on every release; copy the latest from
> `public/widget/widget.js.sha384` after running `pnpm build:widget`.

```html
<meta name="contextlayer-api-key" content="cl_REPLACE_WITH_YOUR_KEY">
<script
  src="https://cdn.contextlayer.io/widget.js"
  data-tenant="REPLACE_WITH_YOUR_TENANT_ID"
  integrity="sha384-b07a/1q8tcpnymHHX7z8R2Nl3Al4l5zptIBgRNRlkPEb3Cm8J11isaU2NOn/u5yr"
  crossorigin="anonymous"
  async
></script>
```

## CSP

Your Content-Security-Policy must allow:

- `script-src https://cdn.contextlayer.io`
- `connect-src https://api.contextlayer.io https://auth.contextlayer.io`
- `style-src 'unsafe-inline'` (the widget injects a single `<style>` block) — or we can move to a hashed stylesheet in a follow-up.

## Bundle size

11.07 KB raw, 11.07 KB on the wire (gzip typically halves this).

## Flow

1. Widget fetches `GET /api/v1/widget/config?tenant=X` with the API key.
2. Widget fetches `GET /api/v1/widget/session-check?tenant=X` with `credentials: 'include'`. The `__Host-context-layer-session` cookie travels cross-origin.
3. If `{ authenticated: true, visitorId }` → chat bubble mounts immediately.
4. If `{ authenticated: false, signInUrl }` → bubble mounts with a "Sign in" CTA. Click opens `auth.contextlayer.io` in a popup; on success the popup posts `{ type: 'contextlayer-auth-success', visitorId }` to `window.opener` and closes.
5. Widget validates `event.origin === 'https://auth.contextlayer.io'`, switches the bubble to chat input.
