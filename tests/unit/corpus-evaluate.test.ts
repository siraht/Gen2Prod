import { describe, expect, test } from "bun:test";
import { contentPreservation } from "../../src/corpus/evaluate.ts";

describe("naturalistic evaluation invariants", () => {
  test("measures content, URL, and form preservation independently", () => {
    const source = '<main><h1>Build better sites</h1><a href="/quote">Get a quote</a><form action="/lead"><label>Email<input name="email"></label><button type="submit">Send</button></form></main>';
    const candidate = '<main><h1>Build better sites</h1><a href="/quote">Get a quote</a><form><label>Email<input name="email"></label></form></main>';
    const result = contentPreservation(source, candidate);
    expect(result.textRecall).toBeGreaterThan(0.7);
    expect(result.urlRecall).toBe(0.5);
    expect(result.formRecall).toBe(0.5);
  });

  test("does not count head stylesheet links as page URL authority", () => {
    const source = '<html><head><link rel="stylesheet" href="https://cdn.example/styles.css"></head><body><a href="/work">Work</a></body></html>';
    const candidate = '<html><head></head><body><a href="/work">Work</a></body></html>';
    expect(contentPreservation(source, candidate).urlRecall).toBe(1);
  });
});
