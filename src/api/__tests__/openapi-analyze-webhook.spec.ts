import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from '../openapi.js';

describe('OpenAPI analyze request schema', () => {
  it('documents optional webhook_url on AnalyzeRequest', () => {
    const spec = buildOpenApiSpec();
    const analyzeRequest = spec.components.schemas.AnalyzeRequest;

    expect(analyzeRequest.properties.webhook_url).toEqual({
      type: 'string',
      format: 'uri',
    });
  });
});
