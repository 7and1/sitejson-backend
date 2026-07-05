import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from '../openapi.js';

describe('OpenAPI DNS schema', () => {
  it('documents A, AAAA, and CAA records on DnsReport', () => {
    const spec = buildOpenApiSpec();
    const dnsReport = spec.components.schemas.DnsReport;

    expect(dnsReport.properties).toMatchObject({
      aRecords: {
        type: 'array',
        items: { type: 'string' },
      },
      aaaaRecords: {
        type: 'array',
        items: { type: 'string' },
      },
      caaRecords: {
        type: 'array',
        items: { type: 'string' },
      },
    });
  });
});
