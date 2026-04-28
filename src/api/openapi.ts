export const buildOpenApiSpec = () => ({
  openapi: '3.0.3',
  info: {
    title: 'SiteJSON API',
    description: 'Standard API for SiteJSON backend analysis and directory services.',
    version: '1.0.0',
  },
  servers: [
    {
      url: '/',
      description: 'Current server',
    },
  ],
  tags: [
    { name: 'Sites', description: 'Site analysis and report retrieval' },
    { name: 'Jobs', description: 'Async job status' },
    { name: 'Directory', description: 'Directory listing and search' },
    { name: 'Ops', description: 'Operational dashboard metrics' },
    { name: 'Health', description: 'Liveness and readiness probes' },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
    schemas: {
      TraceMeta: {
        type: 'object',
        properties: {
          trace_id: { type: 'string', example: 'trc_123' },
          timing: {
            type: 'object',
            properties: {
              lane_browser_ms: { type: 'number' },
              lane_fetch_ms: { type: 'number' },
              lane_ai_ms: { type: 'number' },
              total_ms: { type: 'number' },
            },
          },
          debug: {
            type: 'object',
            properties: {
              fallback_path: {
                type: 'object',
                properties: {
                  browser: { type: 'string', enum: ['browser', 'direct', 'proxy_grid', 'soax', 'none'] },
                  traffic: { type: 'string', enum: ['similarweb_api', 'rotation', 'flaresolverr', 'proxy_grid', 'soax', 'none'] },
                },
              },
            },
          },
        },
        required: ['trace_id'],
      },
      ErrorObject: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'INVALID_REQUEST' },
          message: { type: 'string', example: 'Body validation failed' },
        },
        required: ['code', 'message'],
      },
      ErrorEnvelope: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [false], example: false },
          error: { $ref: '#/components/schemas/ErrorObject' },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'error', 'meta'],
      },
      AnalyzeRequest: {
        type: 'object',
        properties: {
          domain: { type: 'string', example: 'example.com' },
          force_refresh: { type: 'boolean', default: false },
          force_ai: { type: 'boolean', default: false },
          skip_ai: { type: 'boolean', default: false },
          priority: { type: 'string', enum: ['normal', 'high'], default: 'normal' },
        },
        required: ['domain'],
      },
      IngestDomainsRequest: {
        type: 'object',
        properties: {
          domains: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
          priority: { type: 'string', enum: ['normal', 'high'], default: 'normal' },
          force_refresh: { type: 'boolean', default: false },
          force_ai: { type: 'boolean', default: false },
          skip_ai: { type: 'boolean', default: false },
        },
        required: ['domains'],
      },
      IngestDomainsResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              accepted_count: { type: 'integer' },
              skipped_count: { type: 'integer' },
              invalid_count: { type: 'integer' },
              invalid_domains: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['accepted_count', 'skipped_count', 'invalid_count', 'invalid_domains'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
      AnalyzeResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              job_id: { type: 'string', nullable: true, example: 'job_123' },
              status: { type: 'string', enum: ['pending', 'completed'], example: 'pending' },
              priority: { type: 'string', enum: ['normal', 'high'], example: 'normal' },
              reason: { type: 'string', enum: ['QUEUED', 'ALREADY_FRESH'], example: 'QUEUED' },
            },
            required: ['job_id', 'status', 'priority', 'reason'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
      Freshness: {
        type: 'object',
        properties: {
          is_stale: { type: 'boolean' },
          updated_at: { type: 'string', format: 'date-time' },
        },
        required: ['is_stale', 'updated_at'],
      },
      ProviderHealthItem: {
        type: 'object',
        properties: {
          provider: { type: 'string', example: 'meta.provider' },
          ok: { type: 'boolean' },
          errorCode: { type: 'string' },
        },
        required: ['provider', 'ok'],
      },
      VisualReport: {
        type: 'object',
        properties: {
          screenshotUrl: { type: 'string' },
          screenshotPath: { type: 'string' },
          dominantColor: { type: 'string', example: '#336699' },
          palette: {
            type: 'array',
            items: { type: 'string' },
          },
          storage: {
            type: 'string',
            enum: ['local', 'r2'],
          },
        },
      },
      MetaReport: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          techStackDetected: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      SeoReport: {
        type: 'object',
        properties: {
          h1Count: { type: 'number' },
          h2Count: { type: 'number' },
          internalLinks: { type: 'number' },
          externalLinks: { type: 'number' },
          imagesCount: { type: 'number' },
        },
      },
      FilesReport: {
        type: 'object',
        properties: {
          hasRobots: { type: 'boolean' },
          hasSitemap: { type: 'boolean' },
          robotsSitemapUrls: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      DnsReport: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          mxRecords: {
            type: 'array',
            items: { type: 'string' },
          },
          nsRecords: {
            type: 'array',
            items: { type: 'string' },
          },
          txtRecords: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      AdsReport: {
        type: 'object',
        properties: {
          isAdvertiser: { type: 'boolean' },
          advertiserIds: {
            type: 'array',
            items: { type: 'string' },
          },
          advertiserNames: {
            type: 'array',
            items: { type: 'string' },
          },
          resultCount: { type: 'number' },
          transparencySignals: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      PublisherReport: {
        type: 'object',
        properties: {
          hasAdsTxt: { type: 'boolean' },
          adSystems: {
            type: 'array',
            items: { type: 'string' },
          },
          directCount: { type: 'number' },
          resellerCount: { type: 'number' },
          monetizationSignals: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      TrafficRegion: {
        type: 'object',
        properties: {
          country: { type: 'string' },
          share: { type: 'number' },
        },
        required: ['country', 'share'],
      },
      TrafficKeyword: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          volume: { type: 'number' },
          cpc: { type: 'number' },
        },
        required: ['keyword', 'volume', 'cpc'],
      },
      TrafficWhois: {
        type: 'object',
        properties: {
          registrar: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time', nullable: true },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          updatedAt: { type: 'string', format: 'date-time', nullable: true },
          nameservers: {
            type: 'array',
            items: { type: 'string' },
          },
          status: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      TrafficReport: {
        type: 'object',
        properties: {
          monthlyVisits: { type: 'number' },
          globalRank: { type: 'number', nullable: true },
          countryRank: { type: 'number', nullable: true },
          bounceRate: { type: 'number', nullable: true },
          avgVisitDuration: { type: 'number', nullable: true },
          pagesPerVisit: { type: 'number', nullable: true },
          topCountry: { type: 'string' },
          topRegions: {
            type: 'array',
            items: { $ref: '#/components/schemas/TrafficRegion' },
          },
          topKeywords: {
            type: 'array',
            items: { $ref: '#/components/schemas/TrafficKeyword' },
          },
          domainAgeYears: { type: 'number', nullable: true },
          whois: { $ref: '#/components/schemas/TrafficWhois', nullable: true },
        },
      },
      RadarReport: {
        type: 'object',
        properties: {
          globalRank: { type: 'number', nullable: true },
          rankBucket: { type: 'string' },
          sourceTimestamp: { type: 'string', format: 'date-time' },
          categories: {
            type: 'array',
            items: { type: 'string' },
          },
          queued: { type: 'boolean' },
        },
      },
      TaxonomyReport: {
        type: 'object',
        properties: {
          iabCategory: { type: 'string' },
          iabSubCategory: { type: 'string' },
          confidence: { type: 'number' },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
          source: { type: 'string', example: 'gemini_iab' },
        },
      },
      AiClassification: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          subCategory: { type: 'string' },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      AiBusiness: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          model: { type: 'string' },
          targetAudience: { type: 'string' },
        },
      },
      AiRisk: {
        type: 'object',
        properties: {
          sentiment: { type: 'string', enum: ['Professional', 'Spammy'] },
          score: { type: 'number' },
          isSpam: { type: 'boolean' },
        },
      },
      AiAnalysisReport: {
        type: 'object',
        properties: {
          classification: { $ref: '#/components/schemas/AiClassification' },
          business: { $ref: '#/components/schemas/AiBusiness' },
          risk: { $ref: '#/components/schemas/AiRisk' },
        },
      },
      SiteMetaTiming: {
        type: 'object',
        properties: {
          lane_browser_ms: { type: 'number' },
          lane_fetch_ms: { type: 'number' },
          lane_ai_ms: { type: 'number' },
          total_ms: { type: 'number' },
        },
      },
      SiteMetaHtml: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['browser', 'direct', 'proxy_grid', 'soax', 'none'] },
          length: { type: 'number' },
          primary_h1: { type: 'string' },
        },
      },
      SiteMetaAi: {
        type: 'object',
        properties: {
          evaluated: { type: 'boolean' },
          triggered: { type: 'boolean' },
          reason: { type: 'string', enum: ['skip_ai', 'force_ai', 'auto', 'disabled', 'no_signal', 'spam_guard', 'ai_provider_missing', 'no_rank'] },
        },
      },
      SiteMetaDebug: {
        type: 'object',
        properties: {
          fallback_path: {
            type: 'object',
            properties: {
              browser: { type: 'string', enum: ['browser', 'direct', 'proxy_grid', 'soax', 'none'] },
              traffic: { type: 'string', enum: ['similarweb_api', 'rotation', 'flaresolverr', 'proxy_grid', 'soax', 'none'] },
            },
          },
        },
      },
      SiteMeta: {
        type: 'object',
        properties: {
          timing: { $ref: '#/components/schemas/SiteMetaTiming' },
          html: { $ref: '#/components/schemas/SiteMetaHtml' },
          ai: { $ref: '#/components/schemas/SiteMetaAi' },
          debug: { $ref: '#/components/schemas/SiteMetaDebug' },
        },
      },
      SiteReport: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          updatedAt: { type: 'string', format: 'date-time' },
          freshnessTtlSec: { type: 'number' },
          visual: { $ref: '#/components/schemas/VisualReport' },
          meta: { $ref: '#/components/schemas/MetaReport' },
          seo: { $ref: '#/components/schemas/SeoReport' },
          files: { $ref: '#/components/schemas/FilesReport' },
          dns: { $ref: '#/components/schemas/DnsReport' },
          ads: { $ref: '#/components/schemas/AdsReport' },
          publisher: { $ref: '#/components/schemas/PublisherReport' },
          trafficData: { $ref: '#/components/schemas/TrafficReport' },
          radar: { $ref: '#/components/schemas/RadarReport' },
          taxonomy: { $ref: '#/components/schemas/TaxonomyReport' },
          aiAnalysis: { $ref: '#/components/schemas/AiAnalysisReport' },
          providerHealth: {
            type: 'array',
            items: { $ref: '#/components/schemas/ProviderHealthItem' },
          },
          _meta: { $ref: '#/components/schemas/SiteMeta' },
        },
        required: ['domain', 'updatedAt'],
      },
      SiteGetResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              domain: { type: 'string' },
              status: { type: 'string', enum: ['completed'], example: 'completed' },
              freshness: { $ref: '#/components/schemas/Freshness' },
              report: { $ref: '#/components/schemas/SiteReport' },
            },
            required: ['domain', 'status', 'freshness', 'report'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
      JobResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              job_id: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
              priority: { type: 'string', enum: ['normal', 'high'] },
              progress: { type: 'number' },
              stage: { type: 'string' },
              updated_at: { type: 'string', format: 'date-time' },
            },
            required: ['job_id', 'status', 'priority', 'progress', 'updated_at'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
      DirectoryItem: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          title: { type: 'string' },
          rank: { type: 'number' },
        },
        required: ['domain', 'title'],
      },
      DirectoryResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: { $ref: '#/components/schemas/DirectoryItem' },
              },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'number' },
                  page_size: { type: 'number' },
                  total: { type: 'number' },
                },
                required: ['page', 'page_size', 'total'],
              },
              filters: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['category', 'technology', 'topic'] },
                  slug: { type: 'string' },
                },
                required: ['type', 'slug'],
              },
            },
            required: ['items', 'pagination', 'filters'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
      AlternativeSiteItem: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          title: { type: 'string' },
          rank: { type: 'integer' },
          score: { type: 'number' },
          reasons: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['domain', 'title', 'rank', 'score', 'reasons'],
      },
      AlternativesResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              algorithm: { type: 'string', enum: ['rule_based', 'semantic_embedding'] },
              items: {
                type: 'array',
                items: { $ref: '#/components/schemas/AlternativeSiteItem' },
              },
            },
            required: ['algorithm', 'items'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
      OpsRecentItem: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          domain: { type: 'string' },
          status: { type: 'string' },
          priority: { type: 'string' },
          stage: { type: 'string' },
          rank: { type: 'number', nullable: true },
          updated_at: { type: 'string', format: 'date-time' },
          error_message: { type: 'string' },
        },
        required: ['job_id', 'domain', 'status', 'priority', 'rank', 'updated_at'],
      },
      OpsDashboardResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              window: { type: 'string', enum: ['1h'] },
              queue: {
                type: 'object',
                properties: {
                  waiting: { type: 'number' },
                  active: { type: 'number' },
                  completed: { type: 'number' },
                  failed: { type: 'number' },
                  delayed: { type: 'number' },
                  prioritized: { type: 'number' },
                },
                required: ['waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'],
              },
              jobs: {
                type: 'object',
                properties: {
                  created_total: { type: 'number' },
                  running: { type: 'number' },
                  completed: { type: 'number' },
                  failed: { type: 'number' },
                  success_rate: { type: 'number' },
                  avg_e2e_seconds: { type: 'number' },
                },
                required: ['created_total', 'running', 'completed', 'failed', 'success_rate', 'avg_e2e_seconds'],
              },
              quality: {
                type: 'object',
                properties: {
                  traffic_coverage: { type: 'number' },
                },
                required: ['traffic_coverage'],
              },
              recent_items: {
                type: 'array',
                items: { $ref: '#/components/schemas/OpsRecentItem' },
              },
              generated_at: { type: 'string', format: 'date-time' },
              queue_by_type: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    waiting: { type: 'integer' },
                    active: { type: 'integer' },
                    completed: { type: 'integer' },
                    failed: { type: 'integer' },
                    delayed: { type: 'integer' },
                    prioritized: { type: 'integer' },
                  },
                  required: ['waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'],
                },
              },
            },
            required: ['window', 'queue', 'jobs', 'quality', 'recent_items', 'generated_at'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
      HealthResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'alive' },
            },
            required: ['status'],
          },
        },
        required: ['ok', 'data'],
      },
      ReadyResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ready' },
              queue: { type: 'boolean' },
              jobs: { type: 'boolean' },
              sites: { type: 'boolean' },
            },
            required: ['status', 'queue', 'jobs', 'sites'],
          },
        },
        required: ['ok', 'data'],
      },
      ReadyFailureResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [false] },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', enum: ['NOT_READY'] },
              message: { type: 'string' },
            },
            required: ['code', 'message'],
          },
          data: {
            type: 'object',
            properties: {
              queue: { type: 'boolean' },
              jobs: { type: 'boolean' },
              sites: { type: 'boolean' },
            },
            required: ['queue', 'jobs', 'sites'],
          },
        },
        required: ['ok', 'error', 'data'],
      },
      OpsQueuesResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              queues: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    waiting: { type: 'integer' },
                    active: { type: 'integer' },
                    completed: { type: 'integer' },
                    failed: { type: 'integer' },
                    delayed: { type: 'integer' },
                    prioritized: { type: 'integer' },
                  },
                  required: ['waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'],
                },
              },
            },
            required: ['queues'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
      RetryDlqRequest: {
        type: 'object',
        properties: {
          queue: { type: 'string', enum: ['ingest', 'browser_realtime', 'browser', 'async', 'radar', 'traffic', 'whois'] },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        },
        required: ['queue'],
      },
      RetryDlqResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: {
            type: 'object',
            properties: {
              queue: { type: 'string' },
              retried_count: { type: 'integer' },
            },
            required: ['queue', 'retried_count'],
          },
          meta: { $ref: '#/components/schemas/TraceMeta' },
        },
        required: ['ok', 'data', 'meta'],
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/api/v1/sites/analyze': {
      post: {
        summary: 'Create or deduplicate analysis job',
        tags: ['Sites'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AnalyzeRequest' },
            },
          },
        },
        responses: {
          '202': {
            description: 'Accepted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AnalyzeResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request/domain',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '409': {
            description: 'Job already running',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '500': {
            description: 'Internal error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/ingest/domains': {
      post: {
        summary: 'Batch ingest domains',
        tags: ['Sites'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/IngestDomainsRequest' },
            },
          },
        },
        responses: {
          '202': {
            description: 'Accepted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/IngestDomainsResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/sites/{domain}': {
      get: {
        summary: 'Get latest site profile and freshness metadata',
        tags: ['Sites'],
        parameters: [
          {
            in: 'path',
            name: 'domain',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SiteGetResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid domain',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '404': {
            description: 'Site not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/sites/{domain}/alternatives': {
      get: {
        summary: 'Get alternative sites for a domain',
        tags: ['Sites'],
        parameters: [
          {
            in: 'path',
            name: 'domain',
            required: true,
            schema: { type: 'string' },
          },
          {
            in: 'query',
            name: 'limit',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 20, default: 6 },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            headers: {
              'Cache-Control': {
                schema: { type: 'string' },
                description: 'public, s-maxage=900, stale-while-revalidate=1800',
              },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AlternativesResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '404': {
            description: 'Site not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/jobs/{jobId}': {
      get: {
        summary: 'Get job status',
        tags: ['Jobs'],
        parameters: [
          {
            in: 'path',
            name: 'jobId',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JobResponse' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '404': {
            description: 'Job not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/directory/{type}/{slug}': {
      get: {
        summary: 'Directory listing',
        tags: ['Directory'],
        parameters: [
          {
            in: 'path',
            name: 'type',
            required: true,
            schema: { type: 'string', enum: ['category', 'technology', 'topic'] },
          },
          {
            in: 'path',
            name: 'slug',
            required: true,
            schema: { type: 'string' },
          },
          {
            in: 'query',
            name: 'page',
            required: false,
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            in: 'query',
            name: 'page_size',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DirectoryResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/ops/dashboard': {
      get: {
        summary: 'Operations dashboard',
        tags: ['Ops'],
        parameters: [
          {
            in: 'query',
            name: 'window',
            required: false,
            schema: { type: 'string', enum: ['1h'], default: '1h' },
          },
          {
            in: 'query',
            name: 'recent_limit',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OpsDashboardResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '500': {
            description: 'Internal error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/ops/queues': {
      get: {
        summary: 'Queue counts by type',
        tags: ['Ops'],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OpsQueuesResponse' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/ops/retry-dlq': {
      post: {
        summary: 'Retry failed jobs for a queue',
        tags: ['Ops'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RetryDlqRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RetryDlqResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
    },
    '/api/v1/healthz': {
      get: {
        summary: 'Liveness probe',
        tags: ['Health'],
        security: [],
        responses: {
          '200': {
            description: 'Alive',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/api/v1/readyz': {
      get: {
        summary: 'Readiness probe',
        tags: ['Health'],
        security: [],
        responses: {
          '200': {
            description: 'Ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReadyResponse' },
              },
            },
          },
          '503': {
            description: 'Not ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReadyFailureResponse' },
              },
            },
          },
        },
      },
    },
  },
});
