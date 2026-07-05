import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from '../openapi.js';

describe('OpenAPI queue overload responses', () => {
  it('documents queue-overload responses on analyze and ingest endpoints', () => {
    const spec = buildOpenApiSpec();
    const analyzeResponses = spec.paths['/api/v1/sites/analyze'].post.responses;
    const ingestResponses = spec.paths['/api/v1/ingest/domains'].post.responses;

    expect(analyzeResponses['503']).toEqual({
      description: 'Queue capacity temporarily exhausted',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        },
      },
    });

    expect(ingestResponses['429']).toEqual({
      description: 'Ingest rate limit exceeded',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        },
      },
    });

    expect(ingestResponses['503']).toEqual({
      description: 'Queue capacity temporarily exhausted',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        },
      },
    });
  });
});
