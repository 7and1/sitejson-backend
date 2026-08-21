export const SIMILARWEB_SEED_MAX_BATCH_SIZE = 10;
export const SIMILARWEB_SEED_MAX_RADAR_RANK = 1_000_000;

type SimilarwebSeedCandidate = {
  domain: string;
  radarRank: number;
  updatedAt: string;
};

// Prefixes keep smaller configured batches balanced; all ten slots resolve to 2/3/3/2.
const BUCKET_ALLOCATION_ORDER = [1, 2, 3, 4, 2, 3, 1, 4, 2, 3] as const;

const normalizeLimit = (limit: number): number => {
  const normalized = Number.isFinite(limit) ? Math.trunc(limit) : 1;
  return Math.max(1, Math.min(SIMILARWEB_SEED_MAX_BATCH_SIZE, normalized));
};

const resolveBucket = (radarRank: number): number | null => {
  if (!Number.isInteger(radarRank) || radarRank < 1 || radarRank > SIMILARWEB_SEED_MAX_RADAR_RANK) {
    return null;
  }
  if (radarRank <= 1_000) return 1;
  if (radarRank <= 10_000) return 2;
  if (radarRank <= 100_000) return 3;
  return 4;
};

const compareCandidates = <T extends SimilarwebSeedCandidate>(left: T, right: T): number => {
  if (left.radarRank !== right.radarRank) {
    return left.radarRank - right.radarRank;
  }

  const leftUpdatedAt = new Date(left.updatedAt).getTime();
  const rightUpdatedAt = new Date(right.updatedAt).getTime();
  const safeLeftUpdatedAt = Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : Number.POSITIVE_INFINITY;
  const safeRightUpdatedAt = Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : Number.POSITIVE_INFINITY;
  if (safeLeftUpdatedAt !== safeRightUpdatedAt) {
    return safeLeftUpdatedAt - safeRightUpdatedAt;
  }

  if (left.domain < right.domain) return -1;
  if (left.domain > right.domain) return 1;
  return 0;
};

export const getSimilarwebSeedBucketQuotas = (limit: number): [number, number, number, number] => {
  const quotas: [number, number, number, number] = [0, 0, 0, 0];
  for (const bucket of BUCKET_ALLOCATION_ORDER.slice(0, normalizeLimit(limit))) {
    quotas[bucket - 1] += 1;
  }
  return quotas;
};

export const selectSimilarwebSeedCandidates = <T extends SimilarwebSeedCandidate>(
  candidates: T[],
  limit: number,
): T[] => {
  const safeLimit = normalizeLimit(limit);
  const quotas = getSimilarwebSeedBucketQuotas(safeLimit);
  const buckets: T[][] = [[], [], [], []];

  for (const candidate of candidates) {
    const bucket = resolveBucket(candidate.radarRank);
    if (bucket !== null) {
      buckets[bucket - 1].push(candidate);
    }
  }

  const selected: T[] = [];
  const selectedDomains = new Set<string>();
  for (let index = 0; index < buckets.length; index += 1) {
    const bucketCandidates = buckets[index].sort(compareCandidates);
    for (const candidate of bucketCandidates.slice(0, quotas[index])) {
      selected.push(candidate);
      selectedDomains.add(candidate.domain);
    }
  }

  if (selected.length < safeLimit) {
    const backfill = candidates
      .filter((candidate) => resolveBucket(candidate.radarRank) !== null)
      .filter((candidate) => !selectedDomains.has(candidate.domain))
      .sort(compareCandidates)
      .slice(0, safeLimit - selected.length);
    selected.push(...backfill);
  }

  return selected.sort(compareCandidates);
};
