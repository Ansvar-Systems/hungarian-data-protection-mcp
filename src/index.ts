#!/usr/bin/env node

/**
 * Hungarian Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying NAIH decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: hu_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "hungarian-data-protection-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "hu_dp_search_decisions",
    description:
      "Full-text search across NAIH decisions (határozatok, bírságok, figyelmeztetések). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'hozzájárulás sütik', 'Budapest Bank', 'adattovábbítás')",
        },
        type: {
          type: "string",
          enum: ["bírság", "figyelmeztetés", "határozat", "tájékoztató"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'consent', 'cookies', 'transfers'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
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
        reference: {
          type: "string",
          description: "NAIH decision reference (e.g., 'NAIH-2021-1234', 'NAIH/2022/123')",
        },
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
        query: {
          type: "string",
          description: "Search query (e.g., 'adatvédelmi hatásvizsgálat', 'sütik hozzájárulás', 'munkavállalók')",
        },
        type: {
          type: "string",
          enum: ["tájékoztató", "iránymutatás", "állásfoglalás", "útmutató"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'dpia', 'cookies', 'breach_notification'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "hu_dp_get_guideline",
    description:
      "Get a specific NAIH guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from hu_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "hu_dp_list_topics",
    description:
      "List all covered data protection topics with Hungarian and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hu_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
        return textContent({ results, count: results.length });
      }

      case "hu_dp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.reference);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.reference}`);
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
        return textContent({ results, count: results.length });
      }

      case "hu_dp_get_guideline": {
        const parsed = GetGuidelineArgs.parse(args);
        const guideline = getGuideline(parsed.id);
        if (!guideline) {
          return errorContent(`Guideline not found: id=${parsed.id}`);
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
        });
      }

      case "hu_dp_list_topics": {
        const topics = listTopics();
        return textContent({ topics, count: topics.length });
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
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
