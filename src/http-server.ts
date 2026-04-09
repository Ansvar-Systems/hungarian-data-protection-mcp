#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "hungarian-data-protection-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

const RESPONSE_META = {
  disclaimer:
    "Informational only — not legal advice. Always verify with the official NAIH source at naih.hu.",
  data_age:
    "Periodically scraped from naih.hu; content may lag official publications.",
  copyright:
    "© Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH). Reproduced for research and informational purposes.",
  source_url: "https://naih.hu/",
};

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "hu_dp_search_decisions",
    description:
      "Full-text search across NAIH decisions (határozatok, bírságok, figyelmeztetések). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'hozzájárulás sütik', 'Budapest Bank', 'adattovábbítás')" },
        type: {
          type: "string",
          enum: ["bírság", "figyelmeztetés", "határozat", "tájékoztató"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "hu_dp_get_decision",
    description:
      "Get a specific NAIH decision by reference number (e.g., 'NAIH-2021-1234', 'NAIH/2022/123').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "NAIH decision reference (e.g., 'NAIH-2021-1234', 'NAIH/2022/123')" },
      },
      required: ["reference"],
    },
  },
  {
    name: "hu_dp_search_guidelines",
    description:
      "Search NAIH guidance documents: tájékoztatók, iránymutatások, and állásfoglalások. Covers GDPR implementation, adatvédelmi hatásvizsgálat (DPIA), cookie consent, workplace monitoring, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'adatvédelmi hatásvizsgálat', 'sütik hozzájárulás', 'munkavállalók')" },
        type: {
          type: "string",
          enum: ["tájékoztató", "iránymutatás", "állásfoglalás", "útmutató"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "hu_dp_get_guideline",
    description: "Get a specific NAIH guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "hu_dp_list_topics",
    description: "List all covered data protection topics with Hungarian and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "hu_dp_list_sources",
    description: "List all data sources indexed by this MCP server, including URLs and coverage details.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "hu_dp_check_data_freshness",
    description: "Check the freshness of the indexed NAIH data: when it was last scraped and whether it may be stale.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "hu_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["bírság", "figyelmeztetés", "határozat", "tájékoztató"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["tájékoztató", "iránymutatás", "állásfoglalás", "útmutató"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string, errorType = "tool_error") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message, _error_type: errorType }, null, 2),
          },
        ],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "hu_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          const resultsWithCitation = results.map((r) => {
            const d = r as Record<string, unknown>;
            return {
              ...r,
              _citation: buildCitation(
                String(d.reference ?? ""),
                String(d.title ?? d.reference ?? ""),
                "hu_dp_get_decision",
                { reference: String(d.reference ?? "") },
                d.url as string | undefined,
              ),
            };
          });
          return textContent({ results: resultsWithCitation, count: results.length, _meta: RESPONSE_META });
        }

        case "hu_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.reference}`, "not_found");
          }
          const d = decision as Record<string, unknown>;
          return textContent({
            ...decision,
            _citation: buildCitation(
              String(d.reference ?? parsed.reference),
              String(d.title ?? d.reference ?? parsed.reference),
              "hu_dp_get_decision",
              { reference: parsed.reference },
              d.url as string | undefined,
            ),
            _meta: RESPONSE_META,
          });
        }

        case "hu_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const results = searchGuidelines({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          const resultsWithCitation = results.map((r) => {
            const g = r as Record<string, unknown>;
            return {
              ...r,
              _citation: buildCitation(
                String(g.reference ?? g.title ?? `Guideline #${g.id}`),
                String(g.title ?? g.reference ?? `Guideline #${g.id}`),
                "hu_dp_get_guideline",
                { id: String(g.id ?? "") },
                g.url as string | undefined,
              ),
            };
          });
          return textContent({ results: resultsWithCitation, count: results.length, _meta: RESPONSE_META });
        }

        case "hu_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) {
            return errorContent(`Guideline not found: id=${parsed.id}`, "not_found");
          }
          const g = guideline as Record<string, unknown>;
          return textContent({
            ...guideline,
            _citation: buildCitation(
              String(g.reference ?? g.title ?? `Guideline #${parsed.id}`),
              String(g.title ?? g.reference ?? `Guideline #${parsed.id}`),
              "hu_dp_get_guideline",
              { id: String(parsed.id) },
              g.url as string | undefined,
            ),
            _meta: RESPONSE_META,
          });
        }

        case "hu_dp_list_topics": {
          const topics = listTopics();
          return textContent({ topics, count: topics.length, _meta: RESPONSE_META });
        }

        case "hu_dp_list_sources": {
          return textContent({
            sources: [
              {
                id: "naih_decisions",
                name: "NAIH Határozatok (Decisions)",
                url: "https://naih.hu/",
                description:
                  "NAIH formal decisions, sanctions (bírságok), and warnings (figyelmeztetések) issued under GDPR and Hungarian data protection law.",
                type: "decisions",
              },
              {
                id: "naih_guidelines",
                name: "NAIH Tájékoztatók és Iránymutatások (Guidelines)",
                url: "https://naih.hu/",
                description:
                  "NAIH guidance documents, recommendations (iránymutatások), and position papers (állásfoglalások).",
                type: "guidelines",
              },
            ],
            _meta: RESPONSE_META,
          });
        }

        case "hu_dp_check_data_freshness": {
          return textContent({
            status: "unknown",
            note: "Automated freshness tracking not yet configured. Data is periodically scraped from naih.hu.",
            source_url: "https://naih.hu/",
            recommendation: "Run the ingest script to refresh data: npm run ingest",
            _meta: RESPONSE_META,
          });
        }

        case "hu_dp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "NAIH (Nemzeti Adatvédelmi és Információszabadság Hatóság) MCP server. Provides access to Hungarian data protection authority decisions, sanctions, figyelmeztetések, and official guidance documents.",
            data_source: "NAIH (https://naih.hu/)",
            coverage: {
              decisions: "NAIH határozatok, bírságok, and figyelmeztetések",
              guidelines: "NAIH tájékoztatók, iránymutatások, and állásfoglalások",
              topics: "Consent, cookies, transfers, DPIA (adatvédelmi hatásvizsgálat), breach notification, privacy by design, employee monitoring (munkahelyi adatvédelem), health data, children",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: RESPONSE_META,
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`, "unknown_tool");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`, "internal_error");
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
