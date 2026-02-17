import { semanticScholar } from "./platforms/semantic-scholar.js";
import { crossref } from "./platforms/crossref.js";
import { arxiv } from "./platforms/arxiv.js";
import { pubmed } from "./platforms/pubmed.js";
import { biorxiv, medrxiv } from "./platforms/biorxiv.js";
import type { PlatformSource } from "./platforms/types.js";

const ALL_PLATFORMS: Record<string, PlatformSource> = {
  semantic_scholar: semanticScholar,
  crossref,
  arxiv,
  pubmed,
  biorxiv,
  medrxiv,
};

const DEFAULT_PLATFORMS = "semantic_scholar,crossref,arxiv";

export function getEnabledPlatforms(env: Env): PlatformSource[] {
  const list = (env.ENABLED_PLATFORMS ?? DEFAULT_PLATFORMS)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const platforms: PlatformSource[] = [];
  for (const name of list) {
    const p = ALL_PLATFORMS[name];
    if (p) platforms.push(p);
  }
  return platforms;
}

export function getAllPlatformNames(): string[] {
  return Object.keys(ALL_PLATFORMS);
}
