# Provider Data Reference

11 providers, 5 worker phases. Each provider implements `Provider<T>` and returns a `ProviderResult<T>`.

## Provider → Phase Mapping

| Phase | Queue | Providers |
|-------|-------|-----------|
| browser | `browser` | Visual, Meta, Seo, Ai |
| async | `async` | Dns, Ads, Publisher, Files |
| traffic | `traffic` | Traffic |
| whois | `whois` | Whois |
| radar | `radar` | Radar |

## Provider Output Fields

### 1. VisualProvider

File: `src/providers/visual.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| screenshotUrl | string? | Public URL of screenshot |
| screenshotPath | string? | Local filesystem path |
| dominantColor | string? | Hex color from sharp pixel sampling |
| palette | string[]? | Color palette array |
| storage | `'local' \| 'r2'` | Storage backend |

Fallback chain: browser buffer → Playwright → ProxyGrid → SOAX. Skipped when domain is unreachable.

### 2. MetaProvider

File: `src/providers/meta.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| title | string | Page `<title>` |
| description | string | Meta description |
| techStackDetected | string[] | Detected technologies (Next.js, React, WordPress, Shopify, Cloudflare) |

### 3. SeoProvider

File: `src/providers/seo.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| h1Count | number | H1 tag count |
| h2Count | number | H2 tag count |
| internalLinks | number | Internal link count |
| externalLinks | number | External link count |
| imagesCount | number | Image count |
| contacts.emails | string[] | Extracted email addresses |
| contacts.phones | string[] | Extracted phone numbers (tracking numbers filtered) |
| contacts.socialLinks | string[] | Social media URLs |

### 4. DnsProvider

File: `src/providers/dns.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| provider | string | Inferred DNS provider (Google, Microsoft, Zoho, Cloudflare, Other, Unknown) |
| mxRecords | string[] | MX records |
| nsRecords | string[] | NS records |
| txtRecords | string[] | TXT records |

Uses `Promise.allSettled` — individual record-type failures return `[]` without killing other lookups. Queries Cloudflare DNS-over-HTTPS API.

### 5. AdsProvider

File: `src/providers/ads.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| isAdvertiser | boolean | Has Google Ads transparency entries |
| advertiserIds | string[] | Google advertiser IDs |
| advertiserNames | string[] | Advertiser names |
| resultCount | number | Total ad entries found |
| transparencySignals | string[] | Signal strings |

US-only (region 2840). Regex-based protobuf parsing.

### 6. PublisherProvider

File: `src/providers/publisher.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| hasAdsTxt | boolean | ads.txt file exists and has content |
| adSystems | string[] | Unique ad system domains (max 50) |
| directCount | number | Lines with DIRECT relationship |
| resellerCount | number | Lines with RESELLER relationship |
| monetizationSignals | string[] | `has_ads_txt`, `missing_ads_txt`, `has_ad_systems`, `no_ad_systems` |

Parses IAB ads.txt format: `<domain>, <publisher-id>, <relationship>`. HTML responses treated as missing.

### 7. FilesProvider

File: `src/providers/files.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| hasRobots | boolean | robots.txt exists |
| hasSitemap | boolean | sitemap.xml exists |
| robotsSitemapUrls | string[] | URLs from `Sitemap:` directives in robots.txt (max 50) |

robots.txt fetched via GET (up to 64KB) and parsed for `Sitemap:` directives. sitemap.xml checked via HEAD with GET fallback.

### 8. TrafficProvider

File: `src/providers/traffic.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| monthlyVisits | number | Monthly visit estimate |
| globalRank | number? | Global traffic rank |
| countryRank | number? | Country traffic rank |
| bounceRate | number? | Bounce rate (0-1) |
| avgVisitDuration | number? | Average visit duration (seconds) |
| pagesPerVisit | number? | Pages per visit |
| trafficSources | object? | `{ direct, search, social, referral, mail, paid }` |
| topKeywords | array | `[{ keyword, volume, cpc }]` |
| topRegions | array | `[{ countryCode, country, share }]` |
| dataYear | string? | Data year |
| dataMonth | string? | Data month |
| cachedAt | number? | Cache timestamp |

5-source waterfall: SimilarWeb API → traffic.cv rotation → FlareSolverr → ProxyGrid → SOAX.

### 9. WhoisProvider

File: `src/providers/whois.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| whois.registrar | string? | Registrar name from RDAP |
| whois.createdAt | string? | Domain registration date |
| whois.expiresAt | string? | Domain expiry date |
| whois.updatedAt | string? | Last WHOIS update date |
| whois.nameservers | string[] | Nameserver list |
| whois.status | string[] | EPP status codes |
| domainAgeYears | number? | Derived: `(now - createdAt) / 365.25`, rounded to 1dp |

RDAP lookup chain: rdap.org → hardcoded TLD servers → IANA bootstrap (24h cache).

### 10. RadarProvider

File: `src/providers/radar.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| globalRank | number? | Cloudflare Radar global rank |
| rankBucket | string? | Rank tier bucket |
| categories | string[] | Radar categories (populated by single-domain API, empty from CSV bulk) |
| sourceTimestamp | string? | Data timestamp |
| queued | boolean | Whether a single-domain API refresh was queued |

### 11. AiProvider

File: `src/providers/ai.provider.ts`

| Field | Type | Description |
|-------|------|-------------|
| iabCategory | string | IAB category |
| iabSubCategory | string | IAB sub-category |
| confidence | number | Classification confidence (0-1) |
| tags | string[] | Content tags |
| business.summary | string | Business description |
| business.model | string | Business model |
| business.targetAudience | string | Target audience |
| risk.sentiment | `'Professional' \| 'Spammy'` | Overall sentiment |
| risk.score | number | Risk score (0-100) |
| risk.isSpam | boolean | Spam flag |
| visualAnalysis? | object | Anthropic vision path only: `{ designStyle, uiScore, vibe, logoText? }` |

3 backend support: Gemini, OpenAI, Anthropic. Visual analysis only via Anthropic vision.

## Worker Cooldown / TTL

| Worker | Success TTL | Failure TTL | Force Refresh |
|--------|-------------|-------------|---------------|
| BrowserWorker | freshness_ttl_sec (default 7d) | exponential backoff | via `forceRefresh` |
| TrafficWorker | 168h (7d) | exponential backoff capped at 720h | via `forceRefresh` |
| WhoisWorker | 720h (30d) | `168h * 2^(errorCount-1)` capped at 720h | via `forceRefresh` |
| RadarSyncWorker | N/A (bulk sync) | N/A | N/A |
