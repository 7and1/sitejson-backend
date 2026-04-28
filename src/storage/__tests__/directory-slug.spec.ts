import { describe, expect, it } from 'vitest';
import { InMemorySiteRepository } from '../in-memory.js';
import { normalizeDirectoryList, normalizeDirectorySlug } from '../directory-slug.js';

describe('directory slug normalization', () => {
  it('matches the canonical frontend slug behavior for representative labels', () => {
    expect(normalizeDirectorySlug('Technology & Computing')).toBe('technology-and-computing');
    expect(normalizeDirectorySlug('Next.js')).toBe('nextjs');
    expect(normalizeDirectorySlug('AI/ML')).toBe('ai-ml');
    expect(normalizeDirectorySlug('Café SaaS')).toBe('cafe-saas');
    expect(normalizeDirectorySlug('React.js')).toBe('reactjs');
    expect(normalizeDirectorySlug('Sales & CRM')).toBe('sales-and-crm');
    expect(normalizeDirectorySlug('Children’s Media')).toBe('childrens-media');
    expect(normalizeDirectorySlug('News/Politics')).toBe('news-politics');
  });

  it('deduplicates and removes empty normalized list items', () => {
    expect(normalizeDirectoryList([' React ', 'React', '...'])).toEqual(['react']);
  });
});

describe('InMemorySiteRepository directory lookup', () => {
  it('finds category records using canonical slugs emitted by the frontend', async () => {
    const repo = new InMemorySiteRepository();

    await repo.upsert({
      domain: 'example.com',
      updatedAt: new Date().toISOString(),
      meta: { title: 'Example' },
      taxonomy: { iabCategory: 'Technology & Computing', tags: ['AI/ML'] },
    });

    const result = await repo.searchDirectory('category', 'technology-and-computing', 1, 24);

    expect(result.total).toBe(1);
    expect(result.items[0]?.domain).toBe('example.com');
  });

  it('finds technology records using canonical slugs emitted by the frontend', async () => {
    const repo = new InMemorySiteRepository();

    await repo.upsert({
      domain: 'example.com',
      updatedAt: new Date().toISOString(),
      meta: { title: 'Example', techStackDetected: ['Next.js'] },
      taxonomy: { iabCategory: 'Technology & Computing' },
    });

    const result = await repo.searchDirectory('technology', 'nextjs', 1, 24);

    expect(result.total).toBe(1);
    expect(result.items[0]?.domain).toBe('example.com');
  });

  it('emits normalized slugs in directory summaries', async () => {
    const repo = new InMemorySiteRepository();

    await repo.upsert({
      domain: 'example.com',
      updatedAt: new Date().toISOString(),
      meta: { title: 'Example', techStackDetected: ['Next.js'] },
      taxonomy: { iabCategory: 'Technology & Computing', tags: ['AI/ML'] },
    });

    const categorySummary = await repo.getDirectoryTypeSummary('category', 10);
    const technologySummary = await repo.getDirectoryTypeSummary('technology', 10);
    const topicSummary = await repo.getDirectoryTypeSummary('topic', 10);

    expect(categorySummary.slugs[0]?.slug).toBe('technology-and-computing');
    expect(technologySummary.slugs[0]?.slug).toBe('nextjs');
    expect(topicSummary.slugs[0]?.slug).toBe('ai-ml');
  });
});
