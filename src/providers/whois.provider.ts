import type { CrawlContext } from '../core/types.js';
import { providerFailure, providerSuccess } from './base.js';
import type { Provider } from './base.js';
import { fetchWithRetry } from './http.js';
import type { ProviderRuntimeOptions, WhoisData, WhoisLookupData } from './types.js';

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, Array<[string, Record<string, unknown>, string, string]>];
}

interface RdapResponse {
  events?: RdapEvent[];
  entities?: RdapEntity[];
  nameservers?: Array<{ ldhName?: string }>;
  status?: string[];
  createdAt?: string;
  created_at?: string;
  expiresAt?: string;
  expires_at?: string;
  updatedAt?: string;
  updated_at?: string;
}

interface RdapBootstrapResponse {
  services?: unknown;
}

type RdapBootstrapService = {
  tlds: string[];
  urls: string[];
};

type RdapLookupSource = {
  name: string;
  url: string;
};

const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const RDAP_DEFAULT_LOOKUP_URL = 'https://rdap.org/domain/{domain}';
const RDAP_BOOTSTRAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const COMMON_TLD_FALLBACK_BASE_URL: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1',
  net: 'https://rdap.verisign.com/net/v1',
  org: 'https://rdap.publicinterestregistry.org/rdap',
};

let rdapBootstrapCache: {
  expiresAt: number;
  services: RdapBootstrapService[];
} | null = null;

const normalizeDomain = (domain: string): string => {
  return domain.trim().toLowerCase().replace(/\.+$/u, '');
};

const extractDomainSuffixCandidates = (domain: string): string[] => {
  const labels = normalizeDomain(domain).split('.').filter((item) => item.length > 0);
  const candidates: string[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    candidates.push(labels.slice(i).join('.'));
  }
  return candidates;
};

const buildRdapDomainUrl = (baseUrl: string, domain: string): string => {
  const trimmedBase = baseUrl.trim().replace(/\/+$/u, '');
  return `${trimmedBase}/domain/${encodeURIComponent(domain)}`;
};

const parseRdapBootstrapServices = (payload: RdapBootstrapResponse): RdapBootstrapService[] => {
  if (!Array.isArray(payload.services)) {
    return [];
  }

  const parsed: RdapBootstrapService[] = [];

  for (const entry of payload.services) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }

    const [rawTlds, rawUrls] = entry;
    if (!Array.isArray(rawTlds) || !Array.isArray(rawUrls)) {
      continue;
    }

    const tlds = rawTlds
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
    const urls = rawUrls
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.startsWith('http://') || item.startsWith('https://'));

    if (tlds.length === 0 || urls.length === 0) {
      continue;
    }

    parsed.push({ tlds, urls });
  }

  return parsed;
};

const getCachedRdapBootstrap = async (
  options: ProviderRuntimeOptions,
  userAgent: string,
): Promise<RdapBootstrapService[]> => {
  const now = Date.now();
  if (rdapBootstrapCache && now < rdapBootstrapCache.expiresAt) {
    return rdapBootstrapCache.services;
  }

  try {
    const response = await fetchWithRetry(RDAP_BOOTSTRAP_URL, {
      timeoutMs: Math.min(options.timeoutMs ?? 8_000, 5_000),
      retryAttempts: 0,
      retryBaseMs: Math.max(50, options.retryBaseMs ?? 500),
      requestInit: {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': userAgent,
        },
      },
    });

    const payload = await response.json() as RdapBootstrapResponse;
    const services = parseRdapBootstrapServices(payload);
    if (services.length > 0) {
      rdapBootstrapCache = {
        expiresAt: now + RDAP_BOOTSTRAP_CACHE_TTL_MS,
        services,
      };
    }
    return services;
  } catch {
    return rdapBootstrapCache?.services ?? [];
  }
};

const resolveRdapLookupSources = async (
  domain: string,
  options: ProviderRuntimeOptions,
  userAgent: string,
): Promise<RdapLookupSource[]> => {
  const normalizedDomain = normalizeDomain(domain);
  const sources: RdapLookupSource[] = [];
  const seen = new Set<string>();

  const appendSource = (name: string, url: string) => {
    if (!url || seen.has(url)) {
      return;
    }
    seen.add(url);
    sources.push({ name, url });
  };

  appendSource('rdap.org', RDAP_DEFAULT_LOOKUP_URL.replace('{domain}', encodeURIComponent(normalizedDomain)));

  const domainSuffixes = extractDomainSuffixCandidates(normalizedDomain);
  const tld = domainSuffixes.at(-1);
  if (tld && COMMON_TLD_FALLBACK_BASE_URL[tld]) {
    appendSource(
      `registry-common:${tld}`,
      buildRdapDomainUrl(COMMON_TLD_FALLBACK_BASE_URL[tld], normalizedDomain),
    );
  }

  const bootstrapServices = await getCachedRdapBootstrap(options, userAgent);
  for (const suffix of domainSuffixes) {
    const matchedUrls = bootstrapServices
      .filter((service) => service.tlds.includes(suffix))
      .flatMap((service) => service.urls);

    if (matchedUrls.length === 0) {
      continue;
    }

    for (const baseUrl of matchedUrls) {
      appendSource(
        `registry-bootstrap:${suffix}`,
        buildRdapDomainUrl(baseUrl, normalizedDomain),
      );
    }
    break;
  }

  return sources;
};

const parseEventTimestamp = (value: string): number | null => {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const pickFirstDate = (...values: Array<string | null | undefined>): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
};

const extractEventDate = (events: RdapEvent[] | undefined, action: string): string | null => {
  if (!Array.isArray(events)) return null;
  const event = events.find((item) => item.eventAction === action);
  return event?.eventDate ?? null;
};

const findEarliestPastEventDate = (events: RdapEvent[] | undefined): string | null => {
  if (!Array.isArray(events)) return null;

  const now = Date.now();
  let earliestDate: string | null = null;
  let earliestTimestamp: number | null = null;

  for (const event of events) {
    const eventDate = event?.eventDate;
    if (!eventDate) continue;

    const eventTimestamp = parseEventTimestamp(eventDate);
    if (eventTimestamp === null || eventTimestamp > now) continue;

    if (earliestTimestamp === null || eventTimestamp < earliestTimestamp) {
      earliestTimestamp = eventTimestamp;
      earliestDate = eventDate;
    }
  }

  return earliestDate;
};

const extractRegistrar = (entities: RdapEntity[] | undefined): string | null => {
  if (!Array.isArray(entities)) return null;

  const registrarEntity = entities.find((entity) => entity.roles?.includes('registrar'));
  if (!registrarEntity?.vcardArray) return null;

  try {
    const rows = registrarEntity.vcardArray[1];
    const fn = rows.find((item) => item[0] === 'fn');
    return fn ? fn[3] : null;
  } catch {
    return null;
  }
};

const parseWhoisData = (payload: RdapResponse): WhoisData | null => {
  const registrationDate = extractEventDate(payload.events, 'registration');
  const fallbackEventDate = registrationDate ? null : findEarliestPastEventDate(payload.events);
  const createdAt = pickFirstDate(
    registrationDate,
    fallbackEventDate,
    payload.createdAt,
    payload.created_at,
  );
  const expiresAt = pickFirstDate(
    extractEventDate(payload.events, 'expiration'),
    payload.expiresAt,
    payload.expires_at,
  );
  const updatedAt = pickFirstDate(
    extractEventDate(payload.events, 'last changed'),
    payload.updatedAt,
    payload.updated_at,
  );
  const nameservers = (payload.nameservers ?? [])
    .map((item) => item.ldhName)
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
  const status = (payload.status ?? []).filter((item): item is string => typeof item === 'string');
  const registrar = extractRegistrar(payload.entities);

  if (!registrar && !createdAt && !expiresAt && !updatedAt && nameservers.length === 0 && status.length === 0) {
    return null;
  }

  return {
    registrar,
    createdAt,
    expiresAt,
    updatedAt,
    nameservers,
    status,
  };
};

const calculateDomainAge = (registrationDate: string | null): number | null => {
  if (!registrationDate) return null;

  const registrationMs = new Date(registrationDate).getTime();
  if (!Number.isFinite(registrationMs)) return null;

  const ageYears = (Date.now() - registrationMs) / (1000 * 60 * 60 * 24 * 365.25);
  if (!Number.isFinite(ageYears) || ageYears < 0) return null;

  return Math.round(ageYears * 10) / 10;
};

const emptyWhoisLookup: WhoisLookupData = {
  whois: null,
  domainAgeYears: null,
};

export class WhoisProvider implements Provider<WhoisLookupData> {
  readonly name = 'whois.provider';

  constructor(
    private readonly options: ProviderRuntimeOptions,
    private readonly userAgent = 'SiteJSONBot/1.0 (+https://sitejson.com)',
  ) {}

  async run(ctx: CrawlContext) {
    const startedAt = Date.now();
    const lookupSources = await resolveRdapLookupSources(ctx.domain, this.options, this.userAgent);
    const errors: string[] = [];
    let hasNoDataSignal = false;

    for (const source of lookupSources) {
      try {
        const response = await fetchWithRetry(source.url, {
          timeoutMs: this.options.timeoutMs ?? 8_000,
          retryAttempts: this.options.retryAttempts ?? 2,
          retryBaseMs: this.options.retryBaseMs ?? 500,
          requestInit: {
            method: 'GET',
            headers: {
              accept: 'application/rdap+json,application/json',
              'user-agent': this.userAgent,
            },
          },
        });

        const payload = await response.json() as RdapResponse;
        const whois = parseWhoisData(payload);

        if (!whois) {
          hasNoDataSignal = true;
          continue;
        }

        return providerSuccess(this.name, startedAt, {
          whois,
          domainAgeYears: calculateDomainAge(whois.createdAt),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'HTTP_404') {
          hasNoDataSignal = true;
          continue;
        }
        errors.push(`${source.name}:${message || 'WHOIS_LOOKUP_FAILED'}`);
      }
    }

    if (hasNoDataSignal) {
      return providerSuccess(this.name, startedAt, emptyWhoisLookup);
    }

    return providerFailure(
      this.name,
      startedAt,
      'WHOIS_LOOKUP_FAILED',
      errors[0] || 'Whois RDAP lookup failed',
    );
  }
}
