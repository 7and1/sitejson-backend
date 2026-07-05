import { detectTechStack } from './tech-stack.js';

const extractTagContent = (html: string, pattern: RegExp): string | null => {
  const match = html.match(pattern);
  if (!match || !match[1]) {
    return null;
  }

  return match[1].replace(/\s+/g, ' ').trim();
};

const countMatches = (html: string, pattern: RegExp): number => {
  return (html.match(pattern) ?? []).length;
};

const extractLinks = (html: string): { internal: number; external: number } => {
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let internal = 0;
  let external = 0;
  let current: RegExpExecArray | null;

  while ((current = anchorRegex.exec(html)) !== null) {
    const href = current[1].toLowerCase();
    if (href.startsWith('http://') || href.startsWith('https://')) {
      external += 1;
      continue;
    }
    if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) {
      internal += 1;
    }
  }

  return { internal, external };
};

const extractScriptUrls = (html: string): string[] => {
  const scriptRegex = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const urls: string[] = [];
  let current: RegExpExecArray | null;

  while ((current = scriptRegex.exec(html)) !== null) {
    const src = current[1]?.trim();
    if (src) {
      urls.push(src);
    }
  }

  return urls;
};

const extractStylesheetUrls = (html: string): string[] => {
  const stylesheetRegex = /<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  const urls: string[] = [];
  let current: RegExpExecArray | null;

  while ((current = stylesheetRegex.exec(html)) !== null) {
    const href = current[1]?.trim();
    if (href) {
      urls.push(href);
    }
  }

  return urls;
};

export const parseHtmlSignals = (html: string) => {
  const title = extractTagContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '';
  const description =
    extractTagContent(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["'][^>]*>/i) ?? '';

  const h1Count = countMatches(html, /<h1\b[^>]*>/gi);
  const h2Count = countMatches(html, /<h2\b[^>]*>/gi);
  const imagesCount = countMatches(html, /<img\b[^>]*>/gi);
  const links = extractLinks(html);
  const resourceUrls = [
    ...extractScriptUrls(html),
    ...extractStylesheetUrls(html),
  ];
  const primaryH1 = extractTagContent(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? undefined;

  return {
    title,
    description,
    techStackDetected: detectTechStack(html, resourceUrls),
    h1Count,
    h2Count,
    internalLinks: links.internal,
    externalLinks: links.external,
    imagesCount,
    primaryH1,
    contentLength: html.length,
  };
};
