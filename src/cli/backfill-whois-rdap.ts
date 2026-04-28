import { setTimeout as sleep } from 'node:timers/promises';
import { loadEnv } from '../config/env.js';
import { createPostgresPool } from '../storage/postgres.js';

interface BackfillOptions {
  dryRun: boolean;
  batchSize: number;
  limit: number | null;
  concurrency: number;
  timeoutMs: number;
  retryAttempts: number;
}

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

interface WhoisData {
  registrar: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  nameservers: string[];
  status: string[];
}

const CANDIDATE_WHERE = `
  (
    (sp.report_json->'trafficData'->'whois') IS NULL
    OR jsonb_typeof(sp.report_json->'trafficData'->'whois') = 'null'
    OR (sp.report_json->'trafficData'->>'domainAgeYears') IS NULL
  )
`;

const parseArgs = (): BackfillOptions => {
  const options: BackfillOptions = {
    dryRun: false,
    batchSize: 500,
    limit: null,
    concurrency: 5,
    timeoutMs: 8000,
    retryAttempts: 2,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--batch=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.batchSize = value;
    } else if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.limit = value;
    } else if (arg.startsWith('--concurrency=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.concurrency = value;
    } else if (arg.startsWith('--timeout-ms=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
    } else if (arg.startsWith('--retry=')) {
      const value = Number.parseInt(arg.split('=')[1] ?? '', 10);
      if (Number.isFinite(value) && value >= 0) options.retryAttempts = value;
    }
  }

  return options;
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

const fetchWhoisFromRdap = async (
  domain: string,
  options: Pick<BackfillOptions, 'timeoutMs' | 'retryAttempts'>,
): Promise<WhoisData | null> => {
  const maxAttempts = Math.max(1, options.retryAttempts + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
        method: 'GET',
        headers: {
          accept: 'application/rdap+json,application/json',
          'user-agent': 'SiteJSONBot/1.0 (+https://sitejson.com)',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`HTTP_${response.status}`);
      }

      const payload = await response.json() as RdapResponse;
      return parseWhoisData(payload);
    } catch {
      if (attempt < maxAttempts) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
};

const main = async () => {
  const options = parseArgs();
  const env = loadEnv();

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for whois backfill');
  }

  const pool = createPostgresPool(env.DATABASE_URL);

  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM site_profiles sp
       WHERE ${CANDIDATE_WHERE}`,
    );
    const totalCandidates = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);
    console.log(`Candidates needing whois/domainAge backfill: ${totalCandidates}`);

    if (options.dryRun || totalCandidates === 0) {
      return;
    }

    const maxUpdates = options.limit ?? Number.POSITIVE_INFINITY;
    let attempted = 0;
    let updated = 0;
    let withDomainAge = 0;
    let lastDomain = '';

    while (attempted < maxUpdates) {
      const batchLimit = Math.min(options.batchSize, maxUpdates - attempted);
      if (batchLimit <= 0) break;

      const result = await pool.query<{ domain: string }>(
        `
        SELECT sp.domain
        FROM site_profiles sp
        WHERE ${CANDIDATE_WHERE}
          AND sp.domain > $1
        ORDER BY sp.domain ASC
        LIMIT $2
        `,
        [lastDomain, batchLimit],
      );

      if (result.rowCount === 0) {
        break;
      }

      const domains = result.rows.map((row) => row.domain);
      lastDomain = domains[domains.length - 1] ?? lastDomain;

      for (let i = 0; i < domains.length; i += options.concurrency) {
        const chunk = domains.slice(i, i + options.concurrency);
        const updates = await Promise.all(chunk.map(async (domain) => {
          const whois = await fetchWhoisFromRdap(domain, options);
          if (!whois) {
            return { attempted: 1, updated: 0, withDomainAge: 0 };
          }

          const domainAgeYears = calculateDomainAge(whois.createdAt);
          if (domainAgeYears !== null) {
            await pool.query(
              `UPDATE site_profiles
               SET report_json = jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     report_json,
                     '{trafficData}',
                     COALESCE(report_json->'trafficData', '{}'::jsonb),
                     true
                   ),
                   '{trafficData,whois}',
                   $2::jsonb,
                   true
                 ),
                 '{trafficData,domainAgeYears}',
                 to_jsonb($3::numeric),
                 true
               )
               WHERE domain = $1`,
              [domain, JSON.stringify(whois), domainAgeYears],
            );
            return { attempted: 1, updated: 1, withDomainAge: 1 };
          }

          await pool.query(
            `UPDATE site_profiles
             SET report_json = jsonb_set(
               jsonb_set(
                 report_json,
                 '{trafficData}',
                 COALESCE(report_json->'trafficData', '{}'::jsonb),
                 true
               ),
               '{trafficData,whois}',
               $2::jsonb,
               true
             )
             WHERE domain = $1`,
            [domain, JSON.stringify(whois)],
          );
          return { attempted: 1, updated: 1, withDomainAge: 0 };
        }));

        for (const item of updates) {
          attempted += item.attempted;
          updated += item.updated;
          withDomainAge += item.withDomainAge;
        }
      }

      console.log(
        `Attempted ${attempted}, updated ${updated}, domainAge set ${withDomainAge} (limit ${options.limit ?? '∞'})`,
      );
    }
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('WHOIS backfill failed:', error);
  process.exit(1);
});
