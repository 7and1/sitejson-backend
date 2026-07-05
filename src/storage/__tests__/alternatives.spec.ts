import { describe, expect, it } from 'vitest';
import { InMemorySiteRepository } from '../in-memory.js';

describe('InMemorySiteRepository.findAlternatives', () => {
  it('returns ranked alternatives for same category and rank band', async () => {
    const repo = new InMemorySiteRepository();
    const now = new Date().toISOString();

    await repo.upsert({
      domain: 'target.com',
      updatedAt: now,
      meta: { title: 'Target', techStackDetected: ['React', 'Node'] },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS', 'Project Management'] },
      radar: { globalRank: 1000 },
    });

    await repo.upsert({
      domain: 'alt-strong.com',
      updatedAt: now,
      meta: { title: 'Alt Strong', techStackDetected: ['React', 'Node'] },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS', 'Project Management'] },
      radar: { globalRank: 1100 },
    });

    await repo.upsert({
      domain: 'alt-weak.com',
      updatedAt: now,
      meta: { title: 'Alt Weak', techStackDetected: ['PHP'] },
      taxonomy: { iabCategory: 'Technology', tags: ['CRM'] },
      radar: { globalRank: 9500 },
    });

    await repo.upsert({
      domain: 'other-category.com',
      updatedAt: now,
      meta: { title: 'Other Cat', techStackDetected: ['React'] },
      taxonomy: { iabCategory: 'Finance', tags: ['SaaS'] },
      radar: { globalRank: 1200 },
    });

    const result = await repo.findAlternatives('target.com', 6);

    expect(result).not.toBeNull();
    expect(result?.algorithm).toBe('semantic_embedding');
    // alt-strong and alt-weak are same category, other-category matches via tag overlap
    const domains = result?.items.map((item) => item.domain) ?? [];
    expect(domains).toContain('alt-strong.com');
    expect(domains).toContain('alt-weak.com');
    expect(result?.items[0].reasons).toContain('same_category');
    expect(result?.items[0].reasons).toContain('high_tag_overlap');
    expect(result?.items[0].reasons).toContain('shared_tech_stack');
    expect(result?.items[0].score).toBeGreaterThan(result?.items[1].score ?? 0);
  });

  it('returns null when target site does not exist', async () => {
    const repo = new InMemorySiteRepository();
    const result = await repo.findAlternatives('missing.com', 6);
    expect(result).toBeNull();
  });

  it('returns empty items when target has no signals at all', async () => {
    const repo = new InMemorySiteRepository();

    await repo.upsert({
      domain: 'no-signals.com',
      updatedAt: new Date().toISOString(),
      meta: { title: 'No Signals' },
    });

    const result = await repo.findAlternatives('no-signals.com', 6);

    expect(result).not.toBeNull();
    expect(result?.algorithm).toBe('semantic_embedding');
    expect(result?.items).toEqual([]);
  });

  it('ignores low-signal category and tag placeholders', async () => {
    const repo = new InMemorySiteRepository();
    const now = new Date().toISOString();

    await repo.upsert({
      domain: 'target.com',
      updatedAt: now,
      meta: { title: 'Target' },
      taxonomy: { iabCategory: 'Unknown', tags: ['domain-only', 'insufficient-data'] },
    });

    await repo.upsert({
      domain: 'placeholder-match.com',
      updatedAt: now,
      meta: { title: 'Placeholder Match' },
      taxonomy: { iabCategory: 'Unknown', tags: ['domain-only'] },
    });

    const result = await repo.findAlternatives('target.com', 6);

    expect(result).not.toBeNull();
    expect(result?.items).toEqual([]);
  });

  it('returns candidates from different category with similar traffic rank', async () => {
    const repo = new InMemorySiteRepository();
    const now = new Date().toISOString();

    await repo.upsert({
      domain: 'target.com',
      updatedAt: now,
      meta: { title: 'Target' },
      taxonomy: { iabCategory: 'Technology', tags: ['Cloud'] },
      trafficData: { globalRank: 500 },
    });

    await repo.upsert({
      domain: 'finance-similar.com',
      updatedAt: now,
      meta: { title: 'Finance Similar' },
      taxonomy: { iabCategory: 'Finance', tags: ['Banking'] },
      trafficData: { globalRank: 600 },
    });

    const result = await repo.findAlternatives('target.com', 6);

    expect(result).not.toBeNull();
    const domains = result?.items.map((item) => item.domain) ?? [];
    expect(domains).toContain('finance-similar.com');
    const financeItem = result?.items.find((i) => i.domain === 'finance-similar.com');
    expect(financeItem?.reasons).toContain('similar_traffic_rank');
  });

  it('stacks all signals for highest score', async () => {
    const repo = new InMemorySiteRepository();
    const now = new Date().toISOString();

    await repo.upsert({
      domain: 'target.com',
      updatedAt: now,
      meta: { title: 'Target', techStackDetected: ['React', 'Node'] },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS', 'Cloud'] },
      radar: { globalRank: 1000 },
      trafficData: { globalRank: 800 },
    });

    // Perfect match on all dimensions
    await repo.upsert({
      domain: 'perfect.com',
      updatedAt: now,
      meta: { title: 'Perfect', techStackDetected: ['React', 'Node'] },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS', 'Cloud'] },
      radar: { globalRank: 1100 },
      trafficData: { globalRank: 900 },
    });

    // Only category match
    await repo.upsert({
      domain: 'category-only.com',
      updatedAt: now,
      meta: { title: 'Category Only', techStackDetected: ['PHP'] },
      taxonomy: { iabCategory: 'Technology', tags: ['CMS'] },
      radar: { globalRank: 50000 },
    });

    const result = await repo.findAlternatives('target.com', 6);

    expect(result).not.toBeNull();
    expect(result?.items[0].domain).toBe('perfect.com');
    expect(result?.items[0].reasons).toContain('same_category');
    expect(result?.items[0].reasons).toContain('similar_rank_band');
    expect(result?.items[0].reasons).toContain('similar_traffic_rank');
    expect(result?.items[0].reasons).toContain('high_tag_overlap');
    expect(result?.items[0].reasons).toContain('shared_tech_stack');
    expect(result?.items[0].score).toBeGreaterThan(result?.items[1].score ?? 0);
  });

  it('returns candidates with no category but strong tag overlap', async () => {
    const repo = new InMemorySiteRepository();
    const now = new Date().toISOString();

    await repo.upsert({
      domain: 'target.com',
      updatedAt: now,
      meta: { title: 'Target' },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS', 'Analytics', 'Dashboard'] },
      radar: { globalRank: 1000 },
    });

    // No category, but overlapping tags
    await repo.upsert({
      domain: 'uncategorized.com',
      updatedAt: now,
      meta: { title: 'Uncategorized' },
      taxonomy: { tags: ['SaaS', 'Analytics'] },
      radar: { globalRank: 2000 },
    });

    const result = await repo.findAlternatives('target.com', 6);

    expect(result).not.toBeNull();
    const domains = result?.items.map((item) => item.domain) ?? [];
    expect(domains).toContain('uncategorized.com');
    const item = result?.items.find((i) => i.domain === 'uncategorized.com');
    expect(item?.reasons).toContain('high_tag_overlap');
    expect(item?.reasons).not.toContain('same_category');
  });

  it('redistributes rank weight when both ranks missing', async () => {
    const repo = new InMemorySiteRepository();
    const now = new Date().toISOString();

    await repo.upsert({
      domain: 'target.com',
      updatedAt: now,
      meta: { title: 'Target' },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS', 'Cloud'] },
    });

    await repo.upsert({
      domain: 'tag-match.com',
      updatedAt: now,
      meta: { title: 'Tag Match' },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS', 'Cloud'] },
    });

    const result = await repo.findAlternatives('target.com', 6);

    expect(result).not.toBeNull();
    const domains = result?.items.map((item) => item.domain) ?? [];
    expect(domains).toContain('tag-match.com');
    const item = result?.items.find((i) => i.domain === 'tag-match.com');
    // Score should be > 0 even without any rank signal
    expect(item?.score).toBeGreaterThan(0);
    expect(item?.reasons).toContain('same_category');
    expect(item?.reasons).toContain('high_tag_overlap');
    expect(item?.reasons).not.toContain('similar_rank_band');
    expect(item?.reasons).not.toContain('similar_traffic_rank');
  });

  it('returns the cached result when the target report has not changed', async () => {
    const repo = new InMemorySiteRepository();
    const now = new Date().toISOString();

    await repo.upsert({
      domain: 'target.com',
      updatedAt: now,
      meta: { title: 'Target' },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS'] },
      radar: { globalRank: 1000 },
    });

    await repo.upsert({
      domain: 'alt.com',
      updatedAt: now,
      meta: { title: 'Alt' },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS'] },
      radar: { globalRank: 1200 },
    });

    const first = await repo.findAlternatives('target.com', 6);
    const second = await repo.findAlternatives('target.com', 6);

    expect(first).toBe(second);
  });

  it('invalidates the cached result when the target report updates', async () => {
    const repo = new InMemorySiteRepository();
    const firstNow = new Date().toISOString();

    await repo.upsert({
      domain: 'target.com',
      updatedAt: firstNow,
      meta: { title: 'Target' },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS'] },
      radar: { globalRank: 1000 },
    });

    await repo.upsert({
      domain: 'alt.com',
      updatedAt: firstNow,
      meta: { title: 'Alt' },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS'] },
      radar: { globalRank: 1200 },
    });

    const first = await repo.findAlternatives('target.com', 6);

    await repo.upsert({
      domain: 'target.com',
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      meta: { title: 'Target Updated' },
      taxonomy: { iabCategory: 'Technology', tags: ['SaaS', 'AI'] },
      radar: { globalRank: 1000 },
    });

    const second = await repo.findAlternatives('target.com', 6);

    expect(second).not.toBe(first);
  });
});
