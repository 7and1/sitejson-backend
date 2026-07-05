import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from '../openapi.js';

describe('OpenAPI traffic schema', () => {
  it('documents traffic freshness fields on TrafficReport', () => {
    const spec = buildOpenApiSpec();
    const trafficReport = spec.components.schemas.TrafficReport;
    const trafficSources = spec.components.schemas.TrafficSources;

    expect(trafficReport.properties).toMatchObject({
      isStale: { type: 'boolean', nullable: true },
      dataAgeDays: { type: 'number', nullable: true },
      snapshotDate: { type: 'string', nullable: true },
      cachedAt: expect.objectContaining({ type: 'number', nullable: true }),
    });
    expect(trafficReport.properties.trafficSources).toEqual({
      $ref: '#/components/schemas/TrafficSources',
      nullable: true,
    });
    expect(trafficSources.required).toEqual([
      'direct',
      'search',
      'social',
      'referral',
      'mail',
      'paid',
    ]);
  });
});
