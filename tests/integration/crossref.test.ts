import { describe, it, expect } from "vitest";
import { crossref } from "../../src/platforms/crossref";
import { mockEnv } from "./setup";

describe("CrossRef", () => {
  it("searches for papers", async () => {
    const result = await crossref.search(
      { query: "social network analysis", max_results: 3 },
      mockEnv
    );
    expect(result.papers.length).toBeGreaterThan(0);
    expect(result.papers[0].doi).toBeTruthy();
    expect(result.papers[0].source).toBe("crossref");
  });

  it("looks up paper by DOI", async () => {
    const paper = await crossref.getById!(
      "10.1145/3442188.3445922",
      mockEnv
    );
    expect(paper).not.toBeNull();
    expect(paper!.title).toBeTruthy();
    expect(paper!.doi).toBe("10.1145/3442188.3445922");
  });

  it("returns null for nonexistent DOI", async () => {
    const paper = await crossref.getById!(
      "10.9999/nonexistent.doi",
      mockEnv
    );
    expect(paper).toBeNull();
  });
});
