import { Hono } from "hono";
import { SERVER_VERSION, type ServerInfoResponse } from "@car/protocol";
import type { AppContext } from "../context.ts";

export function createInfoRoutes(ctx: AppContext) {
  return new Hono().get("/", c => {
    c.header("Cache-Control", "no-store");
    return c.json({ instanceId: ctx.store.instanceId, serverVersion: SERVER_VERSION,
      agentApiVersion: 1, demo: ctx.config.demo, guidePath: "/agent-guide.md" } satisfies ServerInfoResponse);
  });
}
