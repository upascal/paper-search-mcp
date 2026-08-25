import { describe, it, expect } from "vitest";
import { getOpenAlexCitations, getOpenAlexRelated } from "../../src/platforms/openalex";
import { mockEnv } from "./setup";

// The OpenAlex citation-graph fallback for get_citation_graph and
// find_similar_papers. OpenAlex tolerates unauthenticated use well, so
// unlike the S2 tests these must pass outright — no 429 skip path.
const DOI = "DOI:10.18653/v1/N18-3011"; // Construction of the Literature Graph (NAACL 2018)

describe("OpenAlex citation graph", () => {
  it("citations: returns papers citing the work, most-cited first", async () => {
    const papers = await getOpenAlexCitations(DOI, "citations", mockEnv, { limit: 5 });
    expect(papers.length).toBeGreaterThan(0);
    expect(papers[0].title).toBeTruthy();
    expect(papers[0].source).toBe("openalex");
  });

  it("references: hydrates referenced_works into full records", async () => {
    const papers = await getOpenAlexCitations(DOI, "references", mockEnv, { limit: 5 });
    expect(papers.length).toBeGreaterThan(0);
    expect(papers[0].title).toBeTruthy();
  });

  it("references: works from a bare W-id", async () => {
    const papers = await getOpenAlexCitations("W2801930304", "references", mockEnv, { limit: 3 });
    expect(papers.length).toBeGreaterThan(0);
  });

  it("returns [] for ids outside OpenAlex's resolvable space", async () => {
    const papers = await getOpenAlexCitations("ARXIV:2201.11903", "citations", mockEnv, { limit: 3 });
    expect(papers).toEqual([]);
  });

  it("related works: resolves seeds and excludes them from results", async () => {
    const papers = await getOpenAlexRelated([DOI], mockEnv, { limit: 10 });
    expect(papers.length).toBeGreaterThan(0);
    expect(papers.some((p) => p.doi.toLowerCase() === "10.18653/v1/n18-3011")).toBe(false);
  });
});
