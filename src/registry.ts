import { semanticScholar } from "./platforms/semantic-scholar.js";
import { crossref } from "./platforms/crossref.js";
import { arxiv } from "./platforms/arxiv.js";
import { pubmed } from "./platforms/pubmed.js";
import { biorxiv, medrxiv } from "./platforms/biorxiv.js";
import { openalex } from "./platforms/openalex.js";
import type { PlatformSource } from "./platforms/types.js";

/**
 * Core platforms are always enabled — they provide the metadata signals
 * (FWCI, h-index, venue quality, citations) needed for quality scoring.
 */
const CORE_PLATFORMS: Record<string, PlatformSource> = {
  semantic_scholar: semanticScholar,
  crossref,
  openalex,
};

/** Optional domain-specific platforms, controlled by ENABLED_PLATFORMS env var. */
const OPTIONAL_PLATFORMS: Record<string, PlatformSource> = {
  arxiv,
  pubmed,
  biorxiv,
  medrxiv,
};

const DEFAULT_OPTIONAL = "arxiv";

/**
 * Returns all enabled platforms: core (always on) + optional (env-controlled).
 * ENABLED_PLATFORMS env var only controls optional platforms.
 */
export function getEnabledPlatforms(env: Env): PlatformSource[] {
  const optionalList = (env.ENABLED_PLATFORMS ?? DEFAULT_OPTIONAL)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const platforms: PlatformSource[] = Object.values(CORE_PLATFORMS);

  for (const name of optionalList) {
    const p = OPTIONAL_PLATFORMS[name];
    if (p) platforms.push(p);
  }
  return platforms;
}

export function getOptionalPlatformNames(): string[] {
  return Object.keys(OPTIONAL_PLATFORMS);
}
