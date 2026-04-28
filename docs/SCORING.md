# Legitimacy Scoring Reference

File: `src/scoring/legitimacy.ts`

Computes a 0-100 bounded score from binary signal checks. Each signal adds or subtracts a fixed weight.

## Signals

| Signal | Weight | Condition | Source |
|--------|-------:|-----------|--------|
| `baseline` | +10 | Always | — |
| `has_mx` | +10 | MX records present | DnsProvider |
| `has_ns` | +5 | NS records present | DnsProvider |
| `has_h1` | +5 | >= 1 H1 tag | SeoProvider |
| `internal_links` | +5 | >= 5 internal links | SeoProvider |
| `has_images` | +5 | >= 1 image | SeoProvider |
| `has_title` | +5 | Page title non-empty | MetaProvider |
| `has_description` | +5 | Meta description non-empty | MetaProvider |
| `has_ads_txt` | +5 | ads.txt file present | PublisherProvider |
| `has_rank` | +10 | Global rank > 0 | TrafficProvider / RadarProvider |
| `rank_top_100k` | +5 | Global rank < 100,000 | TrafficProvider / RadarProvider |
| `rank_top_10k` | +5 | Global rank < 10,000 | TrafficProvider / RadarProvider |
| `domain_age_1y` | +5 | Domain age >= 1 year | WhoisProvider |
| `domain_expires_soon` | -5 | Domain expires within 30 days | WhoisProvider |
| `domain_held` | -10 | Status contains clientHold or serverHold | WhoisProvider |
| `ai_professional` | +15 | AI sentiment = "Professional" | AiProvider |
| `spam_signal` | -30 | AI isSpam = true | AiProvider |

## Score Bounds

- Theoretical max: 100 (clamped)
- Theoretical min: 0 (clamped)
- Max positive sum: 10+10+5+5+5+5+5+5+5+10+5+5+5+15 = 95
- Max negative sum: -5-10-30 = -45

## Data Flow

```
SiteReport
  ├── dns.mxRecords / nsRecords       → has_mx, has_ns
  ├── seo.h1Count / internalLinks / imagesCount → has_h1, internal_links, has_images
  ├── meta.title / description         → has_title, has_description
  ├── publisher.hasAdsTxt              → has_ads_txt
  ├── trafficData.globalRank / radar.globalRank → has_rank, rank_top_*
  ├── trafficData.domainAgeYears       → domain_age_1y
  ├── trafficData.whois.expiresAt      → domain_expires_soon
  ├── trafficData.whois.status         → domain_held
  └── aiAnalysis.risk.sentiment/isSpam → ai_professional, spam_signal
```

## Test Coverage

File: `src/scoring/__tests__/legitimacy.spec.ts`

- Bounded score with positive signals
- Spam penalty drives to 0
- Domain expiry penalty
- Domain hold penalty
- No false positives on healthy domains
