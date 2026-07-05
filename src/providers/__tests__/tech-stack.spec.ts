import { describe, expect, it } from 'vitest';
import { detectTechStack } from '../tech-stack.js';
import { parseHtmlSignals } from '../html.js';

describe('detectTechStack', () => {
  it('detects multiple modern frameworks from strong structural markers', () => {
    const html = `
      <html>
        <body>
          <div id="__next"></div>
          <div id="__nuxt"></div>
          <astro-island></astro-island>
        </body>
      </html>
    `;
    const scripts = [
      'https://cdn.example.com/_next/static/chunks/app.js',
      'https://cdn.example.com/_nuxt/entry.js',
      'https://cdn.example.com/_astro/index.js',
    ];

    expect(detectTechStack(html, scripts)).toEqual(
      expect.arrayContaining(['Next.js', 'Nuxt.js', 'Astro']),
    );
  });

  it('detects common CMS and commerce platforms', () => {
    const html = `
      <html>
        <body data-wf-page="abc">
          <div class="shopify-section"></div>
          <link href="/wp-content/themes/example/style.css" rel="stylesheet">
          <script type="application/json" id="drupal-settings-json"></script>
        </body>
      </html>
    `;
    const scripts = [
      'https://cdn.shopify.com/s/files/1/theme.js',
      'https://assets.website-files.com/js/webflow.js',
    ];

    expect(detectTechStack(html, scripts)).toEqual(
      expect.arrayContaining(['Shopify', 'WordPress', 'Drupal', 'Webflow']),
    );
  });

  it('falls back to Unknown when no signatures match', () => {
    expect(detectTechStack('<html><body><h1>Hello</h1></body></html>', [])).toEqual(['Unknown']);
  });

  it('extracts script src URLs from raw HTML for script-based signatures', () => {
    const html = `
      <html>
        <head>
          <script src="https://cdn.jsdelivr.net/npm/alpinejs"></script>
          <script src="https://cdn.example.com/_app/immutable/entry.js"></script>
        </head>
        <body>
          <h1>Example</h1>
        </body>
      </html>
    `;

    expect(parseHtmlSignals(html).techStackDetected).toEqual(
      expect.arrayContaining(['SvelteKit']),
    );
  });

  it('extracts stylesheet href URLs for asset-only signatures', () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5/dist/css/bootstrap.min.css">
        </head>
        <body>
          <h1>Example</h1>
        </body>
      </html>
    `;

    expect(parseHtmlSignals(html).techStackDetected).toEqual(
      expect.arrayContaining(['Bootstrap']),
    );
  });
});
