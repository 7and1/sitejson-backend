import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from '../openapi.js';

describe('OpenAPI traffic history schema', () => {
  it('documents the traffic history route and response schema', () => {
    const spec = buildOpenApiSpec();

    expect(spec.paths['/api/v1/sites/{domain}/traffic-history']).toBeDefined();
    expect(spec.components.schemas.TrafficHistorySnapshot).toBeDefined();
    expect(spec.components.schemas.SiteTrafficHistoryResponse).toBeDefined();
  });
});
