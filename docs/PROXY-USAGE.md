# Proxy Usage

## Proxy Services

SiteJSON uses three proxy services for external HTTP requests:

| Service | Type | Usage | Cost Model |
|---------|------|-------|------------|
| **Rotation proxies** | Residential/datacenter pool | Traffic lane fallback path (SimilarWeb collection/traffic.cv), direct fallback | Per-request, low cost |
| **ProxyGrid** | Self-hosted grid API | HTML fallback, screenshot fallback, optional traffic fallback chain | Self-hosted, fixed cost (currently disabled for SimilarWeb) |
| **SOAX** | Premium residential API | HTML fallback, screenshot + HTML fallback, optional traffic fallback chain | Per-request, high cost |

**Rotation proxies** are configured via `PROXY_LIST` / `PROXY_LIST_FALLBACK` or file-based `PROXY_LIST_FILE` / `PROXY_LIST_FALLBACK_FILE`. ProxyGrid and SOAX are configured via their respective `PROXY_GRID_*` and `SOAX_*` env vars.

## SimilarWeb API Service Proxy Usage (sitejson-similarweb-api/worker)

The SimilarWeb API service (`similarweb-api/`) has its own WAF bypass engine (v3.1) that scrapes `data.similarweb.com` directly. This is separate from the backend's TrafficProvider which calls the SimilarWeb API service.

### Proxy Configuration

| Provider | Status | Success Rate vs CloudFront |
|----------|--------|---------------------------|
| **SOAX** (datacenter) | Active | ~22% per-attempt |
| **Apify** (datacenter) | Active | ~22% per-attempt |
| **BrightData** | Excluded (`SIMILARWEB_PROXY_EXCLUDE_HOSTS`) | 0% — fully blocked |
| **ProxyGrid** | Disabled (`PROXY_GRID_ENABLED=false`) | N/A — service down |

### WAF Bypass Engine v3.1 Anti-Detection Stack

| Layer | Technique |
|-------|-----------|
| TLS | curl-impersonate (Chrome 116 JA3/JA4 fingerprint) |
| HTTP/2 | Auto-negotiated via curl-impersonate |
| Headers | Chrome-exact ordering: sec-ch-ua → UA → Accept → Origin → Referer → Sec-Fetch-* |
| Origin | Always same-site: `Origin: https://www.similarweb.com`, `Sec-Fetch-Site: same-site` |
| Cookies | Persisted across retries via cookie jar (reduces CloudFront re-challenges) |
| Proxy scoring | Adaptive weighting — auto-prefers higher success-rate proxies, 10min decay |
| UA | Consistent per domain session (1800+ pool, but same UA for all retries on one domain) |
| Sessions | Disabled — session template was corrupting proxy auth (caused exit code 56) |

### Retry Strategy

- **Minimal bypass**: up to 8 attempts (`SIMILARWEB_MINIMAL_BYPASS_ATTEMPTS`), 500-1200ms pacing
- **Enhanced bypass**: up to 3 attempts, exponential backoff with strategy switching
- **Task-level retry**: up to 5 attempts (`SIMILARWEB_WORKER_MAX_RETRY_ATTEMPTS`)
- **Concurrency**: 3 (`SIMILARWEB_WORKER_CONCURRENCY`)

### Cost Profile

| Metric | Value |
|--------|-------|
| Domain success rate | 98.9% |
| Per-attempt hit rate | ~22% |
| Avg proxy requests per domain | ~4.5 |
| Waste rate | ~75% (inherent to datacenter IP quality) |
| Block type | CloudFront WAF 403/919B (IP reputation, NOT rate limiting) |

### Key Findings (2026-02-20)

- CloudFront WAF block is **pure IP reputation** — hit rate is constant regardless of request frequency
- Lowering concurrency or adding delays does NOT improve hit rate
- Only residential proxies (60-80% hit rate) can reduce waste, but cost 3-5x more per request
- Current datacenter approach is cost-effective: 4 cheap requests per successful domain

## Per-Phase Proxy Usage Matrix

The orchestrator splits work into five phases, each running a specific set of providers. Proxy usage differs by phase:

| Phase | Queue | Providers | Rotation | ProxyGrid | SOAX |
|-------|-------|-----------|----------|-----------|------|
| **browser** | `browser` | Visual, Meta, Seo, Ai | -- | HTML fallback, screenshot fallback | HTML fallback, screenshot fallback |
| **async** | `async` | Dns, Ads, Publisher, Files | -- | -- | -- |
| **traffic** | `traffic` | Traffic | Yes (traffic.cv path) | Optional (fallback chain) | Optional (fallback chain) |
| **whois** | `whois` | Whois | -- | -- | -- |
| **radar** | `radar` | Radar | -- | -- | -- |

Key observations:
- **Traffic phase is SimilarWeb API first, traffic.cv second.** `TRAFFIC_SIMILARWEB_*` controls the primary source; rotation proxies are used for traffic.cv fallback path.
- **Traffic fallback chain is optional.** When `TRAFFIC_FALLBACK_CHAIN_ENABLED=true` and traffic.cv is blocked, TrafficProvider can escalate to FlareSolverr → ProxyGrid → SOAX.
- **Async, Whois, and Radar phases use no proxies.** Those providers make direct HTTP calls or read local snapshots.
- **Browser phase can trigger ProxyGrid/SOAX** through HTML fallback and VisualProvider screenshot fallbacks.

## Unreachable Gate

Before launching Playwright in the browser phase, the orchestrator runs a two-step reachability pre-check (`orchestrator.ts:150-189`):

1. **DNS resolve** -- `dns.resolve4(domain)`. If this fails, the domain is marked `unreachable`.
2. **HTTP HEAD** -- `HEAD https://{domain}` (3s timeout). If HTTPS fails, tries `HEAD http://{domain}`. If both fail, the domain is marked `unreachable`.

When `ctx.metadata.unreachable = true`:
- **Playwright is skipped** -- no browser launch, no direct screenshot.
- **HTML fallback chain is skipped** (`orchestrator.ts:306`) -- no direct fetch, no ProxyGrid HTML, no SOAX HTML.
- **VisualProvider ProxyGrid screenshot is skipped** (`visual.provider.ts:101`).
- **VisualProvider SOAX screenshot is skipped** (`visual.provider.ts:114`).

This prevents wasting paid proxy calls on domains that cannot be reached by any means.

## HTML Fallback Chain (Browser Phase Only)

When the browser phase fails to capture HTML (Playwright error or no browser), the orchestrator runs `fetchHtmlWithFallbackChain` (`http.ts:506-616`). This chain only runs when:
- The phase is `browser` or no phase is set (full analyze)
- `ctx.metadata.unreachable` is **not** true

The chain tries sources sequentially, stopping at the first success:

1. **Direct fetch** -- `fetchWithRetry` using the configured user-agent. Retries up to `retryAttempts` times with exponential backoff.
2. **ProxyGrid** -- `fetchTextViaProxyGrid`. Tries `/api/grid` first, then `/api/search` (web2md). Each call uses `fetchWithRetry`.
3. **SOAX** -- `fetchTextViaSoax`. Single POST to the SOAX API with `fetchWithRetry`.

## Retry and Fallback Behavior

### fetchWithRetry (`http.ts:276-319`)

Used by direct fetch, ProxyGrid, and SOAX HTML calls:
- Max attempts: `retryAttempts + 1` (default: `PROVIDER_RETRY_ATTEMPTS + 1`)
- Retryable conditions: HTTP 429 or 5xx
- Backoff: exponential (`retryBaseMs * 2^(attempt-1)`), respects `Retry-After` header (capped at 30s)
- Network errors are also retried with the same backoff

### fetchWithProxyRotation (`http.ts:321-378`)

Used exclusively by TrafficProvider:
- Selects up to `TRAFFIC_ROTATION_MAX_PRIMARY_PROXIES` unique-IP proxies from the primary pool (default: 4)
- Appends the full fallback pool
- Tries each proxy sequentially, with `retryBaseMs` backoff between attempts (2x for fallback proxies)
- If all proxies fail, tries a direct (no-proxy) request as final fallback
- No per-proxy retry -- each proxy gets one attempt

### BullMQ Job Retries (`bullmq.ts:5-34`)

Failed jobs are retried at the queue level:

| Queue | Max Attempts | Backoff |
|-------|-------------|---------|
| `browser` | 2 | Exponential, 2000ms base |
| `async` | 3 | Exponential, 500ms base |
| `traffic` | 3 | Exponential, 500ms base |
| `whois` | 3 | Exponential, 500ms base |
| `radar` | 3 (default) | Exponential, 250ms base |
| `ingest` | 3 (default) | Exponential, 250ms base |

### VisualProvider Screenshot Fallbacks

The VisualProvider (`visual.provider.ts:74-177`) tries screenshot sources sequentially:

1. **Pre-captured buffer** -- from Playwright (already captured in orchestrator before browser close)
2. **Browser page** -- live Playwright page screenshot (legacy path, rarely used since orchestrator captures first)
3. **ProxyGrid screenshot** -- `POST /api/search` with `type: screenshot` (30s timeout). Skipped if `unreachable`.
4. **SOAX screenshot** -- `POST` to SOAX API requesting body + screenshot (45s timeout). Skipped if `unreachable`. If SOAX returns HTML and the context has none, it also backfills `ctx.html`.

## Worst-Case Proxy Call Counts Per Domain

### Browser phase (1 domain)

| Source | Calls | Notes |
|--------|-------|-------|
| DNS pre-check | 1 | `dns.resolve4` (free) |
| HTTP HEAD pre-check | 1-2 | HTTPS then HTTP (free, direct) |
| Playwright | 1 | Direct browser navigation |
| HTML fallback: direct | 1 + retries | `fetchWithRetry` (free, direct) |
| HTML fallback: ProxyGrid | 2 + retries each | `/api/grid` then `/api/search` |
| HTML fallback: SOAX | 1 + retries | `fetchTextViaSoax` |
| Screenshot: ProxyGrid | 1 | `fetchProxyGridScreenshot` |
| Screenshot: SOAX | 1 | `fetchSoax` |

**Worst-case paid proxy calls per browser job:** 5 (2 ProxyGrid HTML + 1 SOAX HTML + 1 ProxyGrid screenshot + 1 SOAX screenshot), each with up to `retryAttempts` retries. This only happens when everything fails in sequence.

### Traffic phase (1 domain)

| Source | Calls | Notes |
|--------|-------|-------|
| SimilarWeb API | 1 + retries | `fetchFromSimilarwebApi` |
| traffic.cv via rotation | up to `TRAFFIC_ROTATION_MAX_PRIMARY_PROXIES` primary + N fallback + 1 direct | `fetchWithProxyRotation` |
| Optional fallback chain | up to 3 (+ retries) | FlareSolverr, ProxyGrid, SOAX (only when enabled and rotation is blocked) |

**Worst-case rotation proxy calls:** `min(TRAFFIC_ROTATION_MAX_PRIMARY_PROXIES, uniqueIPs) + fallbackCount + 1`, plus optional fallback-chain calls if enabled.

### Async phase (1 domain)

No proxy calls. All providers use direct HTTP.

### Radar phase (1 domain)

No proxy calls. RadarProvider reads from local snapshot storage.

## Cost Optimization Decisions

### TrafficProvider fallback chain is feature-flagged

**Current behavior:** Traffic lane uses SimilarWeb API first, then traffic.cv via rotation proxies. If `TRAFFIC_FALLBACK_CHAIN_ENABLED=true`, blocked traffic jobs can escalate to FlareSolverr, ProxyGrid, and SOAX before failing.

**Rationale:**
- Keep low-cost SimilarWeb + rotation path as the default.
- Retain higher-cost fallback chain for resilience when anti-bot blocks occur.
- Allow environment-level control (`TRAFFIC_FALLBACK_CHAIN_ENABLED`) to tune reliability vs. cost.

### Unreachable gate prevents proxy waste

**Change:** HTML fallback chain and VisualProvider screenshot fallbacks now check `ctx.metadata.unreachable` before making ProxyGrid/SOAX calls.

**Rationale:**
- If a domain fails DNS resolution or both HTTP/HTTPS HEAD checks, no proxy service will reach it either.
- This prevents 3-5 unnecessary paid proxy calls per unreachable domain.

### HTML fallback chain restricted to browser phase

**Change:** The HTML fallback chain (direct -> ProxyGrid -> SOAX) only runs when `needsBrowser` is true (browser phase or full-analyze).

**Rationale:**
- Async, traffic, and radar phases do not use HTML, so fetching it would be pure waste.
- This was previously gated on `phase !== 'traffic'` which still allowed unnecessary fetches for async/radar phases.
