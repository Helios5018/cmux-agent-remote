import { readFile } from "node:fs/promises";
import { Hono } from "hono";

const guideUrl = new URL("../../../../docs/agent-guide.md", import.meta.url);

export function createAgentGuideRoutes(source: URL = guideUrl) {
  return new Hono().get("/agent-guide.md", async c => {
    c.header("Cache-Control", "no-cache");
    try {
      const markdown = await readFile(source, "utf8");
      if (!markdown.trim()) throw new Error("Empty guide");
      c.header("Content-Type", "text/markdown; charset=utf-8");
      return c.body(markdown);
    } catch {
      return c.text("Agent guide unavailable", 503);
    }
  });
}
