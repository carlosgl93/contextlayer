/**
 * Build the embeddable widget bundle.
 *
 *   pnpm tsx scripts/build-widget.ts
 *
 * Reads `src/widget/mount.ts` as the entry, bundles with esbuild,
 * writes to `public/widget/widget.js`. The bundle is a single
 * IIFE ready to drop into a `<script>` tag. CSS is inlined as a
 * string (no separate .css file) so the B2B customer only needs
 * one `<script>` tag.
 *
 * Output:
 *   - public/widget/widget.js          the bundle
 *   - public/widget/widget.js.sha384   the SRI hash for `<script integrity="...">`
 *   - docs/widget-snippets.md           embedding snippets for B2B onboarding
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENTRY = resolve(ROOT, 'src/widget/mount.ts');
const OUT_JS = resolve(ROOT, 'public/widget/widget.js');
const OUT_HASH = `${OUT_JS}.sha384`;
const OUT_DOCS = resolve(ROOT, 'docs/widget-snippets.md');

async function main() {
  await mkdir(dirname(OUT_JS), { recursive: true });

  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    globalName: 'ContextLayerWidget',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    treeShaking: true,
    outfile: OUT_JS,
    legalComments: 'none',
    metafile: false,
    logLevel: 'info',
  });

  if (result.errors.length > 0) {
    console.error('build failed:', result.errors);
    process.exit(1);
  }

  const bytes = await readFile(OUT_JS);
  const hash = createHash('sha384').update(bytes).digest('base64');
  const integrity = `sha384-${hash}`;
  await writeFile(OUT_HASH, integrity, 'utf8');

  const sizeKb = (bytes.byteLength / 1024).toFixed(2);
  console.log(`✓ widget.js built (${sizeKb} KB)`);
  console.log(`✓ ${integrity}`);

  await writeDocs(integrity, sizeKb, bytes.byteLength);
}

async function writeDocs(integrity: string, sizeKb: string, sizeBytes: number) {
  await mkdir(dirname(OUT_DOCS), { recursive: true });
  const doc = `# Embedding the ContextLayer widget

The widget is a single JS bundle hosted on a CDN. Add the
\`contextlayer-api-key\` meta tag to your site's \`<head>\` and
the snippet below where you want the widget to mount.

> SRI is mandatory. Loading the script without the integrity
> attribute exposes your visitors to a CDN compromise. The hash
> below is regenerated on every release; copy the latest from
> \`public/widget/widget.js.sha384\` after running \`pnpm build:widget\`.

\`\`\`html
<meta name="contextlayer-api-key" content="cl_REPLACE_WITH_YOUR_KEY">
<script
  src="https://cdn.contextlayer.io/widget.js"
  data-tenant="REPLACE_WITH_YOUR_TENANT_ID"
  integrity="${integrity}"
  crossorigin="anonymous"
  async
></script>
\`\`\`

## CSP

Your Content-Security-Policy must allow:

- \`script-src https://cdn.contextlayer.io\`
- \`connect-src https://api.contextlayer.io https://auth.contextlayer.io\`
- \`style-src 'unsafe-inline'\` (the widget injects a single \`<style>\` block) — or we can move to a hashed stylesheet in a follow-up.

## Bundle size

${sizeKb} KB raw, ${(sizeBytes / 1024).toFixed(2)} KB on the wire (gzip typically halves this).

## Flow

1. Widget fetches \`GET /api/v1/widget/config?tenant=X\` with the API key.
2. Widget fetches \`GET /api/v1/widget/session-check?tenant=X\` with \`credentials: 'include'\`. The \`__Host-context-layer-session\` cookie travels cross-origin.
3. If \`{ authenticated: true, visitorId }\` → chat bubble mounts immediately.
4. If \`{ authenticated: false, signInUrl }\` → bubble mounts with a "Sign in" CTA. Click opens \`auth.contextlayer.io\` in a popup; on success the popup posts \`{ type: 'contextlayer-auth-success', visitorId }\` to \`window.opener\` and closes.
5. Widget validates \`event.origin === 'https://auth.contextlayer.io'\`, switches the bubble to chat input.
`;
  await writeFile(OUT_DOCS, doc, 'utf8');
  console.log(`✓ docs/widget-snippets.md updated`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});