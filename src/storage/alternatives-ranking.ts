import type { AlternativeSiteItem } from '../core/types.js';

export type AlternativeTargetSignals = {
  category: string | null;
  rank: number | null;
  trafficRank: number | null;
  tags: string[];
  tech: string[];
  semanticTokens: string[];
};

export type AlternativeCandidate = {
  domain: string;
  title: string;
  rank: number | null;
  trafficRank: number | null;
  categoryText: string | null;
  tags: string[];
  tech: string[];
  description?: string | null;
  businessSummary?: string | null;
  semanticTokens: string[];
};

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'www',
]);

const normalizeTokenSource = (value: string): string => (
  value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
);

export const buildSemanticTokens = (parts: Array<string | null | undefined>): string[] => {
  const tokens: string[] = [];

  for (const part of parts) {
    if (typeof part !== 'string' || part.trim().length === 0) {
      continue;
    }

    const normalized = normalizeTokenSource(part).replace(/[^a-z0-9]+/g, ' ');
    for (const token of normalized.split(/\s+/)) {
      if (token.length < 2 || STOPWORDS.has(token)) {
        continue;
      }
      tokens.push(token);
    }
  }

  return tokens;
};

const buildFrequencyMap = (tokens: string[]): Map<string, number> => {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
};

const cosineSimilarity = (left: string[], right: string[]): number => {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftFreq = buildFrequencyMap(left);
  const rightFreq = buildFrequencyMap(right);

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (const value of leftFreq.values()) {
    leftMagnitude += value * value;
  }
  for (const value of rightFreq.values()) {
    rightMagnitude += value * value;
  }
  for (const [token, leftValue] of leftFreq.entries()) {
    dot += leftValue * (rightFreq.get(token) ?? 0);
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};

const jaccardScore = (left: string[], right: string[]): number => {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) {
      intersection += 1;
    }
  }

  const union = leftSet.size + rightSet.size - intersection;
  return union > 0 ? intersection / union : 0;
};

const rankProximityScore = (targetRank: number, candidateRank: number): number => (
  1 / (1 + Math.abs(Math.log10(targetRank) - Math.log10(candidateRank)))
);

export const toSemanticAlternativeItem = (
  target: AlternativeTargetSignals,
  candidate: AlternativeCandidate,
): AlternativeSiteItem => {
  const semanticSimilarity = cosineSimilarity(target.semanticTokens, candidate.semanticTokens);
  const tagJaccard = jaccardScore(target.tags, candidate.tags);
  const techJaccard = jaccardScore(target.tech, candidate.tech);
  const catMatch = target.category && candidate.categoryText === target.category ? 1 : 0;

  const radarProx = target.rank && candidate.rank && candidate.rank > 0
    ? rankProximityScore(target.rank, candidate.rank)
    : null;
  const trafficProx = target.trafficRank && candidate.trafficRank && candidate.trafficRank > 0
    ? rankProximityScore(target.trafficRank, candidate.trafficRank)
    : null;

  let rankComponent = 0;
  if (radarProx !== null && trafficProx !== null) {
    rankComponent = 0.125 * radarProx + 0.125 * trafficProx;
  } else if (radarProx !== null) {
    rankComponent = 0.25 * radarProx;
  } else if (trafficProx !== null) {
    rankComponent = 0.25 * trafficProx;
  }

  const score = (
    0.35 * semanticSimilarity
    + 0.15 * catMatch
    + 0.15 * tagJaccard
    + 0.10 * techJaccard
    + rankComponent
  );

  const reasons: string[] = [];
  if (semanticSimilarity >= 0.12) reasons.push('semantic_text_similarity');
  if (catMatch > 0) reasons.push('same_category');
  if (radarProx !== null) reasons.push('similar_rank_band');
  if (trafficProx !== null) reasons.push('similar_traffic_rank');
  if (tagJaccard > 0) reasons.push('high_tag_overlap');
  if (techJaccard > 0) reasons.push('shared_tech_stack');

  return {
    domain: candidate.domain,
    title: candidate.title,
    rank: candidate.rank ?? candidate.trafficRank ?? 0,
    score: Number.parseFloat(Math.max(0, Math.min(1, score)).toFixed(6)),
    reasons,
  };
};
