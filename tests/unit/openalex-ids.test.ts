import { describe, it, expect } from "vitest";
import { toWorksKey } from "../../src/platforms/openalex";

// The OpenAlex fallback must only claim ID spaces it can resolve reliably.
// arXiv ids are deliberately EXCLUDED: OpenAlex's DataCite arXiv DOIs are
// unreliable (missing for 1706.03762, hijacked for 2201.11903, duplicate for
// 2005.14165 — verified live 2026-08). Wrong-paper results are worse than none.
describe("toWorksKey", () => {
  it("maps OpenAlex W-ids, bare and URL-form", () => {
    expect(toWorksKey("W2741809807")).toBe("W2741809807");
    expect(toWorksKey("w2741809807")).toBe("W2741809807");
    expect(toWorksKey("https://openalex.org/W2741809807")).toBe("W2741809807");
  });

  it("maps DOIs, bare, prefixed, and URL-form", () => {
    expect(toWorksKey("10.18653/v1/N18-3011")).toBe("doi:10.18653/v1/N18-3011");
    expect(toWorksKey("DOI:10.18653/v1/N18-3011")).toBe("doi:10.18653/v1/N18-3011");
    expect(toWorksKey("https://doi.org/10.18653/v1/N18-3011")).toBe("doi:10.18653/v1/N18-3011");
  });

  it("maps prefixed PMIDs", () => {
    expect(toWorksKey("PMID:31978945")).toBe("pmid:31978945");
  });

  it("returns null for arXiv ids, S2 hashes, and junk", () => {
    expect(toWorksKey("ARXIV:2201.11903")).toBeNull();
    expect(toWorksKey("2201.11903")).toBeNull();
    expect(toWorksKey("649def34f8be52c8b66281af98ae884c09aef38b")).toBeNull();
    expect(toWorksKey("CorpusId:19170988")).toBeNull();
    expect(toWorksKey("")).toBeNull();
  });
});
