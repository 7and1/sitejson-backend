type TechStackSignature = {
  name: string;
  htmlPatterns?: RegExp[];
  resourcePatterns?: RegExp[];
};

const SIGNATURES: TechStackSignature[] = [
  {
    name: 'Next.js',
    htmlPatterns: [/__next/i, /<script[^>]+_next\//i, /next-route-announcer/i],
    resourcePatterns: [/\b\/_next\//i],
  },
  {
    name: 'React',
    htmlPatterns: [/data-reactroot/i, /__react/i],
    resourcePatterns: [/\breact(?:[-.]dom)?\b/i],
  },
  {
    name: 'Vue.js',
    htmlPatterns: [/data-v-[a-f0-9]+/i, /id=["']__vue["']/i],
    resourcePatterns: [/\bvue(?:\.runtime)?(?:\.global)?(?:\.prod)?(?:\.min)?\.js\b/i],
  },
  {
    name: 'Nuxt.js',
    htmlPatterns: [/id=["']__nuxt["']/i],
    resourcePatterns: [/\b\/_nuxt\//i],
  },
  {
    name: 'Angular',
    htmlPatterns: [/\bng-version=/i, /\bng-app\b/i],
    resourcePatterns: [/\bzone(?:\.min)?\.js\b/i],
  },
  {
    name: 'SvelteKit',
    resourcePatterns: [/\b\/_app\/immutable\//i],
  },
  {
    name: 'Astro',
    htmlPatterns: [/<astro-island\b/i],
    resourcePatterns: [/\b\/_astro\//i],
  },
  {
    name: 'Gatsby',
    htmlPatterns: [/___gatsby/i],
    resourcePatterns: [/\b\/page-data\//i],
  },
  {
    name: 'WordPress',
    htmlPatterns: [/\bwp-content\b/i, /\bwp-includes\b/i, /\bwp-json\b/i],
  },
  {
    name: 'WooCommerce',
    htmlPatterns: [/\bwoocommerce\b/i, /\bwc-cart-fragments\b/i],
  },
  {
    name: 'Shopify',
    htmlPatterns: [/\bshopify(?:-section|-payment-button)?\b/i, /\bwindow\.shopify\b/i],
    resourcePatterns: [/\bcdn\.shopify\.com\b/i],
  },
  {
    name: 'BigCommerce',
    resourcePatterns: [/\bbigcommerce\.com\b/i, /\bcdn\d+\.bigcommerce\.com\b/i],
  },
  {
    name: 'Webflow',
    htmlPatterns: [/\bdata-wf-page\b/i, /\bdata-wf-site\b/i],
    resourcePatterns: [/\bwebflow\b/i],
  },
  {
    name: 'Wix',
    resourcePatterns: [/\bwixstatic\.com\b/i, /\bstatic\.parastorage\.com\b/i],
  },
  {
    name: 'Squarespace',
    resourcePatterns: [/\bsquarespace\.com\b/i, /\bstatic1\.squarespace\.com\b/i],
  },
  {
    name: 'Drupal',
    htmlPatterns: [/\bdrupal-settings-json\b/i, /\bdrupal\b/i],
    resourcePatterns: [/\b\/sites\/default\/files\//i],
  },
  {
    name: 'Joomla',
    htmlPatterns: [/\bjoomla!\b/i],
    resourcePatterns: [/\b\/media\/system\/js\//i],
  },
  {
    name: 'Magento',
    htmlPatterns: [/\bmagento\b/i, /\bdata-mage-init\b/i],
    resourcePatterns: [/\b\/static\/version\d+\/frontend\//i],
  },
  {
    name: 'HubSpot',
    resourcePatterns: [/\bjs\.hs-scripts\.com\b/i, /\bjs\.hubspot\.com\b/i],
  },
  {
    name: 'Tailwind CSS',
    resourcePatterns: [/\bcdn\.tailwindcss\.com\b/i],
  },
  {
    name: 'Bootstrap',
    resourcePatterns: [/\bbootstrap(?:\.bundle)?(?:\.min)?\.(?:js|css)\b/i],
  },
  {
    name: 'jQuery',
    resourcePatterns: [/\bjquery(?:[-.]migrate)?(?:\.min)?\.js\b/i],
  },
  {
    name: 'Cloudflare',
    htmlPatterns: [/\bcf-ray\b/i, /\b__cf_bm\b/i],
    resourcePatterns: [/\bcloudflare\b/i],
  },
];

const dedupe = (items: string[]): string[] => Array.from(new Set(items));

export const detectTechStack = (html: string, resourceUrls: string[] = []): string[] => {
  const normalizedHtml = html.toLowerCase();
  const normalizedResources = resourceUrls.map((url) => url.toLowerCase());
  const hits: string[] = [];

  const hasHtmlPattern = (pattern: RegExp): boolean => pattern.test(normalizedHtml);
  const hasResourcePattern = (pattern: RegExp): boolean => normalizedResources.some((url) => pattern.test(url));

  for (const signature of SIGNATURES) {
    const htmlMatched = signature.htmlPatterns?.some(hasHtmlPattern) ?? false;
    const resourceMatched = signature.resourcePatterns?.some(hasResourcePattern) ?? false;
    if (htmlMatched || resourceMatched) {
      hits.push(signature.name);
    }
  }

  return hits.length > 0 ? dedupe(hits) : ['Unknown'];
};
