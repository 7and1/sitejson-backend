import { describe, it, expect } from 'vitest';
import { directoryItemFromListingRow, type DirectoryListingRow } from '../postgres.js';

const baseRow = (): DirectoryListingRow => ({
  domain: 'example.com',
  title: 'Example',
  description: 'An example site',
  tech_stack: ['React', 'Next.js'],
  screenshot_url: 'https://cdn/x.png',
  tags: ['news', 'tech'],
  monthly_visits: '120000',
  rank_int: 1500,
  traffic_rank_int: 2000,
  legitimacy_score_int: 87,
});

describe('directoryItemFromListingRow', () => {
  it('maps a fully-populated row', () => {
    expect(directoryItemFromListingRow(baseRow())).toEqual({
      domain: 'example.com',
      title: 'Example',
      rank: 1500, // radar rank_int preferred over traffic_rank_int
      description: 'An example site',
      screenshotUrl: 'https://cdn/x.png',
      tags: ['news', 'tech'],
      techStack: ['React', 'Next.js'],
      monthlyVisits: 120000,
      legitimacyScore: 87,
    });
  });

  it('falls back to traffic rank, then undefined', () => {
    expect(directoryItemFromListingRow({ ...baseRow(), rank_int: null }).rank).toBe(2000);
    expect(directoryItemFromListingRow({ ...baseRow(), rank_int: null, traffic_rank_int: null }).rank).toBeUndefined();
  });

  it('handles null/empty fields like the full-report mapper', () => {
    const item = directoryItemFromListingRow({
      domain: 'bare.com',
      title: null,
      description: null,
      tech_stack: null,
      screenshot_url: null,
      tags: null,
      monthly_visits: null,
      rank_int: null,
      traffic_rank_int: null,
      legitimacy_score_int: null,
    });
    expect(item).toEqual({
      domain: 'bare.com',
      title: 'bare.com', // falls back to domain
      rank: undefined,
      description: undefined,
      screenshotUrl: undefined,
      tags: undefined,
      techStack: undefined,
      monthlyVisits: undefined,
      legitimacyScore: 0,
    });
  });

  it('caps tags/tech at 5 and ignores non-string entries', () => {
    const item = directoryItemFromListingRow({
      ...baseRow(),
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
      tech_stack: ['x', 1, null, 'y'],
    });
    expect(item.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(item.techStack).toEqual(['x', 'y']);
  });

  it('treats non-numeric monthly_visits as undefined', () => {
    expect(directoryItemFromListingRow({ ...baseRow(), monthly_visits: '' }).monthlyVisits).toBeUndefined();
  });
});
