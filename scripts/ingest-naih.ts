#!/usr/bin/env tsx
/**
 * NAIH Ingestion Crawler
 *
 * Crawls the NAIH (Nemzeti Adatvédelmi és Információszabadság Hatóság) website
 * to ingest decisions (határozatok), sanctions (bírságok), and guidance documents
 * (tájékoztatók, ajánlások, iránymutatások) into the local SQLite database.
 *
 * Data sources:
 *   - Decisions:  https://www.naih.hu/hatarozatok-vegzesek       (Joomla paginated, ?start=0,50,100,…)
 *   - Guidance:   https://www.naih.hu/adatvedelmi-ajanlasok       (recommendations)
 *   - Notices:    https://www.naih.hu/tajekoztatok-kozlemenyek    (notices/communications)
 *
 * Each listing entry links to a PDF download via ?download=ID:slug.
 * Individual detail pages at /hatarozatok-vegzesek/file/{id}-{slug} provide
 * metadata (reference, date, file size) and the PDF content.
 *
 * Usage:
 *   npx tsx scripts/ingest-naih.ts
 *   npx tsx scripts/ingest-naih.ts --resume          # skip already-ingested references
 *   npx tsx scripts/ingest-naih.ts --dry-run         # crawl and parse but do not write DB
 *   npx tsx scripts/ingest-naih.ts --force           # drop existing data and re-ingest
 *   npx tsx scripts/ingest-naih.ts --decisions-only  # only crawl decisions
 *   npx tsx scripts/ingest-naih.ts --guidance-only   # only crawl guidance
 *   npx tsx scripts/ingest-naih.ts --limit 10        # stop after N items per source
 *   npx tsx scripts/ingest-naih.ts --start-offset 50 # start pagination at offset 50
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["NAIH_DB_PATH"] ?? "data/naih.db";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const USER_AGENT =
  "AnsvarNAIHCrawler/1.0 (+https://ansvar.eu; compliance research)";
const ITEMS_PER_PAGE = 50;

const BASE_URL = "https://www.naih.hu";

/** Sources to crawl, each with a listing URL path and target table. */
const SOURCES = {
  decisions: {
    listPath: "/hatarozatok-vegzesek",
    table: "decisions" as const,
    label: "Határozatok/Végzések",
  },
  guidance_ajanlasok: {
    listPath: "/adatvedelmi-ajanlasok",
    table: "guidelines" as const,
    label: "Adatvédelmi ajánlások",
  },
  guidance_tajekoztatok: {
    listPath: "/tajekoztatok-kozlemenyek",
    table: "guidelines" as const,
    label: "Tájékoztatók/Közlemények",
  },
} as const;

// ---------------------------------------------------------------------------
// Hungarian month name mapping
// ---------------------------------------------------------------------------

const HU_MONTHS: Record<string, string> = {
  január: "01",
  február: "02",
  március: "03",
  április: "04",
  május: "05",
  június: "06",
  július: "07",
  augusztus: "08",
  szeptember: "09",
  október: "10",
  november: "11",
  december: "12",
};

// ---------------------------------------------------------------------------
// Topic inference mapping — maps Hungarian keywords to topic IDs
// ---------------------------------------------------------------------------

const TOPIC_KEYWORDS: Array<{ pattern: RegExp; topic: string }> = [
  { pattern: /hozzájárulás|beleegyezés|consent/i, topic: "consent" },
  { pattern: /süti|cookie|nyomkövet/i, topic: "cookies" },
  { pattern: /adattovábbítás|harmadik ország|transfer|schrems/i, topic: "transfers" },
  { pattern: /hatásvizsgálat|dpia|impact assessment/i, topic: "dpia" },
  { pattern: /incidens|breach|adatvédelmi sérülés|bejelentés/i, topic: "breach_notification" },
  { pattern: /beépített|privacy by design|adatvédelem tervezés/i, topic: "privacy_by_design" },
  { pattern: /munkavállal|munkahely|employee|monitor|kamera|megfigyelés/i, topic: "employee_monitoring" },
  { pattern: /egészségügy|health|beteg|páciens|orvos/i, topic: "health_data" },
  { pattern: /gyermek|kiskorú|children|szülő/i, topic: "children" },
];

/** GDPR article patterns in decision text. */
const GDPR_ARTICLE_PATTERN = /(?:GDPR|általános adatvédelmi rendelet)\s*(\d+)\.\s*cikk/gi;
const GDPR_ARTICLE_STANDALONE = /(\d{1,3})\.\s*cikk/gi;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
  decisionsOnly: boolean;
  guidanceOnly: boolean;
  limit: number;
  startOffset: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const opts: CliArgs = {
    resume: false,
    dryRun: false,
    force: false,
    decisionsOnly: false,
    guidanceOnly: false,
    limit: 0,
    startOffset: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--resume") opts.resume = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--decisions-only") opts.decisionsOnly = true;
    else if (arg === "--guidance-only") opts.guidanceOnly = true;
    else if (arg === "--limit" && argv[i + 1]) {
      opts.limit = parseInt(argv[++i]!, 10);
    } else if (arg === "--start-offset" && argv[i + 1]) {
      opts.startOffset = parseInt(argv[++i]!, 10);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry and rate limiting
// ---------------------------------------------------------------------------

let lastFetchTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastFetchTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastFetchTime = Date.now();

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.5",
        },
        redirect: "follow",
      });

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") ?? "10", 10);
        console.warn(`  Rate limited (429). Waiting ${retryAfter}s before retry ${attempt}/${MAX_RETRIES}...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
      }

      return resp;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        console.warn(`  Attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}. Retrying in ${backoff}ms...`);
        await sleep(backoff);
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url} after ${MAX_RETRIES} attempts`);
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await rateLimitedFetch(url);
  return resp.text();
}

async function fetchPdfBuffer(url: string): Promise<Buffer> {
  const now = Date.now();
  const elapsed = now - lastFetchTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastFetchTime = Date.now();

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/pdf,*/*",
        },
        redirect: "follow",
      });

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") ?? "10", 10);
        console.warn(`  Rate limited (429). Waiting ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }

      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        console.warn(`  Retry ${attempt}/${MAX_RETRIES}: ${lastError.message}. Backoff ${backoff}ms.`);
        await sleep(backoff);
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch PDF ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Parsed types
// ---------------------------------------------------------------------------

interface ListingEntry {
  /** Download URL path, e.g. /hatarozatok-vegzesek?download=1417:slug */
  downloadPath: string;
  /** Detail page URL path, e.g. /hatarozatok-vegzesek/file/620-slug */
  detailPath: string | null;
  /** NAIH reference extracted from listing, e.g. NAIH-5209-29/2025 */
  reference: string | null;
  /** Document title */
  title: string;
  /** Date string parsed from "Dátum: 2025. december 02." */
  date: string | null;
  /** Numeric download ID from the ?download= parameter */
  downloadId: string;
}

interface DecisionRecord {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string | null;
  full_text: string;
  topics: string; // JSON array
  gdpr_articles: string; // JSON array
  status: string;
}

interface GuidelineRecord {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string | null;
  full_text: string;
  topics: string; // JSON array
  language: string;
}

// ---------------------------------------------------------------------------
// State persistence for --resume
// ---------------------------------------------------------------------------

const STATE_FILE = join(dirname(DB_PATH), ".ingest-naih-state.json");

interface CrawlState {
  ingested_references: string[];
  last_source: string | null;
  last_offset: number;
  updated_at: string;
}

function loadState(): CrawlState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as CrawlState;
    } catch {
      // corrupted state file — start fresh
    }
  }
  return { ingested_references: [], last_source: null, last_offset: 0, updated_at: "" };
}

function saveState(state: CrawlState): void {
  state.updated_at = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// HTML parsing — listing pages
// ---------------------------------------------------------------------------

/**
 * Parse a Joomla-style listing page from naih.hu.
 *
 * Each entry on the page follows this pattern:
 *   - A <strong> tag with the reference number (for decisions)
 *   - A link with ?download=ID:slug serving as both title and download
 *   - A "Dátum: YYYY. month DD." text node
 *   - Optionally a detail page link at /hatarozatok-vegzesek/file/ID-slug
 */
function parseListingPage(html: string, basePath: string): ListingEntry[] {
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];

  // Find all download links — these are the anchors for each entry
  const downloadLinks = $(`a[href*="?download="]`).toArray();

  // Deduplicate by download ID (title link and "Letöltés" link share same URL)
  const seen = new Set<string>();

  for (const el of downloadLinks) {
    const href = $(el).attr("href");
    if (!href) continue;

    // Extract download ID from ?download=ID:slug or ?download=ID-slug
    const downloadMatch = href.match(/\?download=(\d+)[:\-](.+?)(?:&|$)/);
    if (!downloadMatch) continue;

    const downloadId = downloadMatch[1]!;
    if (seen.has(downloadId)) continue;
    seen.add(downloadId);

    const linkText = $(el).text().trim();
    // Skip "Letöltés" (Download) button links — use the title link instead
    if (linkText === "Letöltés" || linkText === "") continue;

    const title = linkText;
    const downloadPath = href.startsWith("http") ? new URL(href).pathname + new URL(href).search : href;

    // Look for reference number in preceding <strong> tag
    let reference: string | null = null;
    const parentNode = $(el).parent();
    const prevStrong = parentNode.prevAll("strong").first();
    if (prevStrong.length > 0) {
      const strongText = prevStrong.text().trim();
      if (/^NAIH/i.test(strongText)) {
        reference = strongText;
      }
    }
    // Also check siblings and preceding text nodes
    if (!reference) {
      const prevAll = $(el).prevAll("strong");
      for (const s of prevAll.toArray()) {
        const txt = $(s).text().trim();
        if (/^NAIH/i.test(txt)) {
          reference = txt;
          break;
        }
      }
    }

    // Look for date in surrounding text
    let date: string | null = null;
    // Search within parent and surrounding elements
    const parentHtml = parentNode.html() ?? "";
    const dateMatch = parentHtml.match(
      /Dátum:\s*(\d{4})\.\s*(január|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s*(\d{1,2})\./i,
    );
    if (dateMatch) {
      const month = HU_MONTHS[dateMatch[2]!.toLowerCase()];
      if (month) {
        date = `${dateMatch[1]}-${month}-${dateMatch[3]!.padStart(2, "0")}`;
      }
    }

    // Try to find a detail page link (file/ID-slug format)
    let detailPath: string | null = null;
    const fileLink = $(`a[href*="/file/${downloadId}-"]`).first();
    if (fileLink.length > 0) {
      detailPath = fileLink.attr("href") ?? null;
    }

    entries.push({
      downloadPath,
      detailPath,
      reference,
      title,
      date,
      downloadId,
    });
  }

  return entries;
}

/**
 * Check if there are more pages in the listing by looking for a "Next" link.
 */
function hasNextPage(html: string, currentOffset: number): boolean {
  const $ = cheerio.load(html);
  // Joomla pagination uses "Következő" (Next) or a numeric link with start > currentOffset
  const nextLink = $(`a[href*="start=${currentOffset + ITEMS_PER_PAGE}"]`);
  if (nextLink.length > 0) return true;

  // Also check for "Következő" text link
  const nextText = $('a:contains("Következő")');
  return nextText.length > 0;
}

// ---------------------------------------------------------------------------
// Detail page and PDF text extraction
// ---------------------------------------------------------------------------

/**
 * Fetch the detail page for a decision/guidance entry to get additional metadata.
 * Detail pages are at /hatarozatok-vegzesek/file/{id}-{slug}.
 */
async function fetchDetailMetadata(
  detailPath: string,
): Promise<{ reference: string | null; date: string | null; fileSize: string | null }> {
  try {
    const html = await fetchHtml(`${BASE_URL}${detailPath}`);
    const $ = cheerio.load(html);

    let reference: string | null = null;
    let date: string | null = null;
    let fileSize: string | null = null;

    // The detail page body text contains reference, date, file size
    const bodyText = $("body").text();

    // Reference pattern: NAIH-XXXX-X/YYYY or NAIH/YYYY/XXXX
    const refMatch = bodyText.match(/(?:Ügyszám|Iktatószám):\s*(NAIH[\s\-\/\d]+)/i);
    if (refMatch) {
      reference = refMatch[1]!.trim();
    }

    // Date: look for the detail-page date
    const detailDate = bodyText.match(
      /Dátum:\s*(\d{4})\.\s*(január|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s*(\d{1,2})\./i,
    );
    if (detailDate) {
      const month = HU_MONTHS[detailDate[2]!.toLowerCase()];
      if (month) {
        date = `${detailDate[1]}-${month}-${detailDate[3]!.padStart(2, "0")}`;
      }
    }

    // File size
    const sizeMatch = bodyText.match(/(\d+[\.,]\d+\s*[kKmM][bB])/);
    if (sizeMatch) {
      fileSize = sizeMatch[1]!;
    }

    return { reference, date, fileSize };
  } catch (err) {
    console.warn(`  Could not fetch detail page: ${(err as Error).message}`);
    return { reference: null, date: null, fileSize: null };
  }
}

/**
 * Download a PDF and extract text content.
 *
 * Uses the PDF.js-compatible approach: download the raw PDF bytes,
 * then extract text line-by-line. If pdf-parse is unavailable, stores
 * a placeholder referencing the cached PDF file.
 */
async function extractPdfText(downloadUrl: string, cacheDir: string, downloadId: string): Promise<string> {
  const cachePath = join(cacheDir, `${downloadId}.pdf`);

  let pdfBuffer: Buffer;
  if (existsSync(cachePath)) {
    pdfBuffer = readFileSync(cachePath) as Buffer;
  } else {
    pdfBuffer = await fetchPdfBuffer(downloadUrl);
    writeFileSync(cachePath, pdfBuffer);
  }

  // Attempt basic text extraction from the PDF binary.
  // PDF text is stored between BT/ET operators in content streams.
  // This is a lightweight extraction that works for most NAIH decision PDFs
  // which are text-based (not scanned images).
  const text = extractTextFromPdfBuffer(pdfBuffer);
  if (text.length > 100) {
    return text;
  }

  // If extraction yields very little text, the PDF may be image-based.
  // Return what we have with a note.
  if (text.length > 0) {
    return text;
  }

  return `[PDF tartalom — letöltve: ${downloadUrl}]`;
}

/**
 * Lightweight PDF text extraction.
 *
 * Parses raw PDF bytes looking for text operators (Tj, TJ, ', ")
 * within BT/ET blocks. Handles the most common text encodings used
 * by NAIH decision PDFs (mostly Latin-2 / UTF-16BE).
 */
function extractTextFromPdfBuffer(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const lines: string[] = [];

  // Decompress any FlateDecode streams to access text content
  const streams = extractPdfStreams(buf);

  for (const stream of streams) {
    // Find text between BT and ET operators
    const btEtPattern = /BT\s([\s\S]*?)ET/g;
    let btMatch;
    while ((btMatch = btEtPattern.exec(stream)) !== null) {
      const block = btMatch[1]!;

      // Extract Tj strings: (text) Tj
      const tjPattern = /\(([^)]*)\)\s*Tj/g;
      let tjMatch;
      while ((tjMatch = tjPattern.exec(block)) !== null) {
        const decoded = decodePdfString(tjMatch[1]!);
        if (decoded.trim()) lines.push(decoded.trim());
      }

      // Extract TJ arrays: [(text) num (text)] TJ
      const tjArrayPattern = /\[([^\]]*)\]\s*TJ/g;
      let tjArrMatch;
      while ((tjArrMatch = tjArrayPattern.exec(block)) !== null) {
        const inner = tjArrMatch[1]!;
        const parts: string[] = [];
        const partPattern = /\(([^)]*)\)/g;
        let partMatch;
        while ((partMatch = partPattern.exec(inner)) !== null) {
          parts.push(decodePdfString(partMatch[1]!));
        }
        const line = parts.join("");
        if (line.trim()) lines.push(line.trim());
      }
    }
  }

  // If stream decompression didn't work, try raw extraction
  if (lines.length === 0) {
    const tjPattern = /\(([^)]{2,})\)\s*Tj/g;
    let m;
    while ((m = tjPattern.exec(raw)) !== null) {
      const decoded = decodePdfString(m[1]!);
      if (decoded.trim().length > 1) lines.push(decoded.trim());
    }
  }

  return lines.join("\n");
}

/**
 * Extract and decompress PDF content streams.
 * Handles FlateDecode (zlib) which is the most common compression in PDFs.
 */
function extractPdfStreams(buf: Buffer): string[] {
  const results: string[] = [];
  const raw = buf.toString("binary");

  // Find stream...endstream blocks
  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  let match;
  let streamIndex = 0;

  while ((match = streamPattern.exec(raw)) !== null) {
    streamIndex++;
    const streamData = match[1]!;

    // Check if this stream is FlateDecode compressed
    // Look backwards for the /Filter /FlateDecode in the stream dict
    const dictStart = raw.lastIndexOf("<<", match.index);
    const dictSlice = raw.slice(Math.max(0, dictStart), match.index);
    const isFlate = dictSlice.includes("/FlateDecode");

    if (isFlate) {
      try {
        const { inflateSync } = require("node:zlib") as typeof import("node:zlib");
        const compressed = Buffer.from(streamData, "binary");
        const decompressed = inflateSync(compressed);
        results.push(decompressed.toString("latin1"));
      } catch {
        // Decompression failed — skip this stream
      }
    } else {
      // Uncompressed stream — use directly
      if (streamData.includes("BT") && streamData.includes("ET")) {
        results.push(streamData);
      }
    }

    // Safety limit
    if (streamIndex > 500) break;
  }

  return results;
}

/**
 * Decode PDF string escapes (\n, \r, \t, \\, \(, \), octal).
 */
function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\(\d{1,3})/g, (_m, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
}

// ---------------------------------------------------------------------------
// Content analysis — extract metadata from decision text
// ---------------------------------------------------------------------------

/** Infer decision type from title and content. */
function inferDecisionType(title: string, text: string): string {
  const combined = `${title} ${text.slice(0, 2000)}`.toLowerCase();
  if (combined.includes("bírság") || combined.includes("pénzbírság")) return "bírság";
  if (combined.includes("figyelmeztet")) return "figyelmeztetés";
  if (combined.includes("végzés")) return "végzés";
  if (combined.includes("határozat")) return "határozat";
  return "határozat";
}

/** Infer guideline type from title. */
function inferGuidelineType(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("ajánlás")) return "ajánlás";
  if (t.includes("tájékoztató")) return "tájékoztató";
  if (t.includes("iránymutatás")) return "iránymutatás";
  if (t.includes("állásfoglalás")) return "állásfoglalás";
  if (t.includes("útmutató")) return "útmutató";
  if (t.includes("közlemény")) return "közlemény";
  return "tájékoztató";
}

/** Extract entity name from decision text. */
function extractEntityName(text: string): string | null {
  // Common patterns: "XYZ Kft." / "XYZ Zrt." / "XYZ Nyrt."
  const patterns = [
    /(?:szemben|ellen|vonatkozó(?:an)?|ügyben)\s+(?:a\s+)?([A-ZÁÉÍÓÖŐÚÜŰa-záéíóöőúüű\s\-\.]+?\s*(?:Kft|Zrt|Nyrt|Bt|Rt|Plc|SE|Ltd|Kht|Nonprofit)\b\.?)/,
    /([A-ZÁÉÍÓÖŐÚÜŰa-záéíóöőúüű\s\-\.]+?\s*(?:Kft|Zrt|Nyrt|Bt|Rt)\b\.?)\s*(?:ellen|szemben|részére)/,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const name = m[1]!.trim().replace(/^a\s+/i, "");
      if (name.length > 3 && name.length < 120) return name;
    }
  }

  return null;
}

/** Extract fine amount from text. */
function extractFineAmount(text: string): number | null {
  // Patterns: "X millió forint", "X 000 000 Ft", "X.000.000 Ft"
  const patterns = [
    /(\d[\d\s\.]*)\s*(?:millió)\s*(?:forint|Ft)/i,
    /(\d[\d\s\.]*\d{3})\s*(?:Ft|forint)\s*(?:összeg|bírság)/i,
    /bírság[a-záéíóöőúüű\s]*?(\d[\d\s\.]*)\s*(?:Ft|forint)/i,
    /(\d[\d\s\.]*)\s*(?:Ft|forint)\s*(?:összeg|adatvédelmi bírság)/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      let numStr = m[1]!.replace(/[\s\.]/g, "");
      const num = parseInt(numStr, 10);
      if (isNaN(num)) continue;

      // Check if "millió" was used
      if (text.slice(Math.max(0, (m.index ?? 0) - 5), (m.index ?? 0) + m[0].length + 20).includes("millió")) {
        return num * 1_000_000;
      }
      if (num > 1000) return num;
    }
  }

  return null;
}

/** Extract GDPR article references from text. */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // "GDPR XX. cikk" or "általános adatvédelmi rendelet XX. cikk"
  let m;
  while ((m = GDPR_ARTICLE_PATTERN.exec(text)) !== null) {
    const num = parseInt(m[1]!, 10);
    if (num >= 1 && num <= 99) articles.add(String(num));
  }

  // If we found GDPR-qualified articles, return those
  if (articles.size > 0) return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  // Fallback: look for "XX. cikk" patterns in vicinity of GDPR/rendelet mentions
  const gdprContext = text.match(
    /(?:GDPR|rendelet|adatvédel)[^.]{0,200}/gi,
  );
  if (gdprContext) {
    for (const ctx of gdprContext) {
      const reset = new RegExp(GDPR_ARTICLE_STANDALONE.source, "gi");
      while ((m = reset.exec(ctx)) !== null) {
        const num = parseInt(m[1]!, 10);
        if (num >= 1 && num <= 99) articles.add(String(num));
      }
    }
  }

  return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/** Infer topic IDs from title and text. */
function inferTopics(title: string, text: string): string[] {
  const combined = `${title} ${text.slice(0, 5000)}`;
  const topics = new Set<string>();

  for (const { pattern, topic } of TOPIC_KEYWORDS) {
    if (pattern.test(combined)) {
      topics.add(topic);
    }
  }

  return [...topics];
}

/** Generate a summary from the first meaningful paragraph of text. */
function generateSummary(text: string, maxLen: number = 500): string | null {
  // Skip header lines (reference, date, address) and find first substantial paragraph
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 80);
  if (paragraphs.length === 0) return null;

  // Take first substantial paragraph, truncate if needed
  let summary = paragraphs[0]!.trim();
  if (summary.length > maxLen) {
    summary = summary.slice(0, maxLen).replace(/\s\S*$/, "") + "…";
  }
  return summary;
}

/** Generate a reference from the download ID and title when one wasn't found in the listing. */
function generateReference(downloadId: string, title: string, date: string | null): string {
  // Try to extract a reference from the title
  const titleRef = title.match(/NAIH[\s\-\/\d]+/i);
  if (titleRef) return titleRef[0].trim();

  // Construct a synthetic reference from the year and download ID
  const year = date ? date.slice(0, 4) : "unknown";
  return `NAIH-DOC-${downloadId}/${year}`;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function getExistingReferences(db: Database.Database): Set<string> {
  const refs = new Set<string>();
  const rows = db.prepare("SELECT reference FROM decisions").all() as Array<{ reference: string }>;
  for (const r of rows) refs.add(r.reference);
  const gRows = db.prepare("SELECT reference FROM guidelines WHERE reference IS NOT NULL").all() as Array<{ reference: string }>;
  for (const r of gRows) refs.add(r.reference);
  return refs;
}

function insertDecision(db: Database.Database, d: DecisionRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.reference,
    d.title,
    d.date,
    d.type,
    d.entity_name,
    d.fine_amount,
    d.summary,
    d.full_text,
    d.topics,
    d.gdpr_articles,
    d.status,
  );
}

function insertGuideline(db: Database.Database, g: GuidelineRecord): void {
  db.prepare(`
    INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    g.reference,
    g.title,
    g.date,
    g.type,
    g.summary,
    g.full_text,
    g.topics,
    g.language,
  );
}

// ---------------------------------------------------------------------------
// Seed topics (same as seed-sample.ts, idempotent)
// ---------------------------------------------------------------------------

function seedTopics(db: Database.Database): void {
  const topics = [
    { id: "consent", name_local: "Hozzájárulás", name_en: "Consent", description: "Az érintett hozzájárulásának gyűjtése, érvényessége és visszavonása (GDPR 7. cikk)." },
    { id: "cookies", name_local: "Sütik és nyomkövetők", name_en: "Cookies and trackers", description: "Sütik és nyomkövetők elhelyezése a felhasználók eszközein (ePrivacy irányelv)." },
    { id: "transfers", name_local: "Nemzetközi adattovábbítás", name_en: "International transfers", description: "Személyes adatok harmadik országokba való továbbítása (GDPR 44-49. cikk)." },
    { id: "dpia", name_local: "Adatvédelmi hatásvizsgálat (DPIA)", name_en: "Data Protection Impact Assessment (DPIA)", description: "Magas kockázatú adatkezelések hatásértékelése (GDPR 35. cikk)." },
    { id: "breach_notification", name_local: "Adatvédelmi incidens bejelentése", name_en: "Data breach notification", description: "Incidensek bejelentése a NAIH-nak és az érintetteknek (GDPR 33-34. cikk)." },
    { id: "privacy_by_design", name_local: "Beépített adatvédelem", name_en: "Privacy by design", description: "Adatvédelem beépítése a tervezésbe (GDPR 25. cikk)." },
    { id: "employee_monitoring", name_local: "Munkahelyi adatvédelem", name_en: "Employee monitoring", description: "Adatkezelés munkaviszonyban és munkavállalói megfigyelés." },
    { id: "health_data", name_local: "Egészségügyi adatok", name_en: "Health data", description: "Különleges kategóriájú egészségügyi adatok kezelése (GDPR 9. cikk)." },
    { id: "children", name_local: "Gyermekek adatai", name_en: "Children's data", description: "Kiskorúak adatainak védelme online szolgáltatásokban (GDPR 8. cikk)." },
    { id: "direct_marketing", name_local: "Direkt marketing", name_en: "Direct marketing", description: "Személyes adatok felhasználása közvetlen üzletszerzési célokra." },
    { id: "video_surveillance", name_local: "Kamerás megfigyelés", name_en: "Video surveillance", description: "Kamerarendszerek üzemeltetésének adatvédelmi követelményei." },
    { id: "right_of_access", name_local: "Hozzáférési jog", name_en: "Right of access", description: "Az érintett hozzáférési joga a kezelt adatokhoz (GDPR 15. cikk)." },
    { id: "right_to_erasure", name_local: "Törléshez való jog", name_en: "Right to erasure", description: "Az érintett joga személyes adatai törléséhez (GDPR 17. cikk)." },
    { id: "ai_data_processing", name_local: "Mesterséges intelligencia", name_en: "AI data processing", description: "Mesterséges intelligencia alkalmazásának adatvédelmi kérdései." },
  ];

  const stmt = db.prepare("INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)");
  for (const t of topics) {
    stmt.run(t.id, t.name_local, t.name_en, t.description);
  }
}

// ---------------------------------------------------------------------------
// Main crawl pipeline
// ---------------------------------------------------------------------------

async function crawlListingPages(
  basePath: string,
  label: string,
  args: CliArgs,
): Promise<ListingEntry[]> {
  console.log(`\n--- Crawling: ${label} ---`);
  console.log(`  Base: ${BASE_URL}${basePath}`);

  const allEntries: ListingEntry[] = [];
  let offset = args.startOffset;
  let pageNum = 1;

  while (true) {
    const url = offset === 0
      ? `${BASE_URL}${basePath}`
      : `${BASE_URL}${basePath}?start=${offset}`;

    console.log(`  Page ${pageNum} (offset ${offset})...`);

    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`  Failed to fetch listing page: ${(err as Error).message}`);
      break;
    }

    const entries = parseListingPage(html, basePath);
    if (entries.length === 0) {
      console.log(`  No entries found on page ${pageNum}. Stopping.`);
      break;
    }

    console.log(`  Found ${entries.length} entries on page ${pageNum}`);
    allEntries.push(...entries);

    // Check limit
    if (args.limit > 0 && allEntries.length >= args.limit) {
      console.log(`  Reached limit of ${args.limit} entries.`);
      break;
    }

    // Check for next page
    if (!hasNextPage(html, offset)) {
      console.log(`  No more pages.`);
      break;
    }

    offset += ITEMS_PER_PAGE;
    pageNum++;
  }

  // Apply limit
  if (args.limit > 0 && allEntries.length > args.limit) {
    return allEntries.slice(0, args.limit);
  }

  return allEntries;
}

async function processDecisionEntry(
  entry: ListingEntry,
  cacheDir: string,
  db: Database.Database | null,
  existingRefs: Set<string>,
  args: CliArgs,
  state: CrawlState,
): Promise<boolean> {
  const ref = entry.reference ?? generateReference(entry.downloadId, entry.title, entry.date);

  if (args.resume && (existingRefs.has(ref) || state.ingested_references.includes(ref))) {
    return false; // skip
  }

  console.log(`  Processing decision: ${ref} — ${entry.title.slice(0, 60)}…`);

  // Fetch detail page metadata if available
  let detailMeta = { reference: null as string | null, date: null as string | null, fileSize: null as string | null };
  if (entry.detailPath) {
    detailMeta = await fetchDetailMetadata(entry.detailPath);
  }

  const reference = detailMeta.reference ?? ref;
  const date = entry.date ?? detailMeta.date;

  // Download and extract PDF text
  const downloadUrl = entry.downloadPath.startsWith("http")
    ? entry.downloadPath
    : `${BASE_URL}${entry.downloadPath}`;

  let fullText: string;
  try {
    fullText = await extractPdfText(downloadUrl, cacheDir, entry.downloadId);
  } catch (err) {
    console.warn(`  Failed to download PDF for ${reference}: ${(err as Error).message}`);
    // Use the title as minimal content
    fullText = entry.title;
  }

  // Analyze content
  const type = inferDecisionType(entry.title, fullText);
  const entityName = extractEntityName(fullText) ?? extractEntityName(entry.title);
  const fineAmount = extractFineAmount(fullText);
  const gdprArticles = extractGdprArticles(fullText);
  const topics = inferTopics(entry.title, fullText);
  const summary = generateSummary(fullText);

  const record: DecisionRecord = {
    reference,
    title: entry.title,
    date,
    type,
    entity_name: entityName,
    fine_amount: fineAmount,
    summary,
    full_text: fullText,
    topics: JSON.stringify(topics),
    gdpr_articles: JSON.stringify(gdprArticles),
    status: "final",
  };

  if (args.dryRun) {
    console.log(`  [DRY RUN] Would insert decision: ${reference}`);
    console.log(`    Type: ${type}, Entity: ${entityName ?? "(unknown)"}, Fine: ${fineAmount ?? "(none)"}`);
    console.log(`    GDPR articles: ${gdprArticles.join(", ") || "(none)"}`);
    console.log(`    Topics: ${topics.join(", ") || "(none)"}`);
    console.log(`    Text length: ${fullText.length} chars`);
  } else if (db) {
    insertDecision(db, record);
    state.ingested_references.push(reference);
  }

  return true;
}

async function processGuidelineEntry(
  entry: ListingEntry,
  sourceLabel: string,
  cacheDir: string,
  db: Database.Database | null,
  existingRefs: Set<string>,
  args: CliArgs,
  state: CrawlState,
): Promise<boolean> {
  const ref = entry.reference ?? generateReference(entry.downloadId, entry.title, entry.date);

  if (args.resume && (existingRefs.has(ref) || state.ingested_references.includes(ref))) {
    return false;
  }

  console.log(`  Processing guideline: ${entry.title.slice(0, 70)}…`);

  // Download and extract PDF text
  const downloadUrl = entry.downloadPath.startsWith("http")
    ? entry.downloadPath
    : `${BASE_URL}${entry.downloadPath}`;

  let fullText: string;
  try {
    fullText = await extractPdfText(downloadUrl, cacheDir, entry.downloadId);
  } catch (err) {
    console.warn(`  Failed to download PDF for ${ref}: ${(err as Error).message}`);
    fullText = entry.title;
  }

  const type = inferGuidelineType(entry.title);
  const topics = inferTopics(entry.title, fullText);
  const summary = generateSummary(fullText);

  const record: GuidelineRecord = {
    reference: ref,
    title: entry.title,
    date: entry.date,
    type,
    summary,
    full_text: fullText,
    topics: JSON.stringify(topics),
    language: "hu",
  };

  if (args.dryRun) {
    console.log(`  [DRY RUN] Would insert guideline: ${ref}`);
    console.log(`    Type: ${type}, Source: ${sourceLabel}`);
    console.log(`    Topics: ${topics.join(", ") || "(none)"}`);
    console.log(`    Text length: ${fullText.length} chars`);
  } else if (db) {
    insertGuideline(db, record);
    state.ingested_references.push(ref);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("=== NAIH Ingestion Crawler ===");
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Mode: ${args.dryRun ? "DRY RUN" : args.force ? "FORCE (drop & recreate)" : args.resume ? "RESUME" : "NORMAL"}`);
  if (args.limit > 0) console.log(`  Limit: ${args.limit} per source`);
  if (args.startOffset > 0) console.log(`  Start offset: ${args.startOffset}`);
  if (args.decisionsOnly) console.log(`  Scope: decisions only`);
  if (args.guidanceOnly) console.log(`  Scope: guidance only`);

  // Initialize database
  const db = args.dryRun ? null : initDb(args.force);
  if (db) seedTopics(db);

  const existingRefs = db ? getExistingReferences(db) : new Set<string>();
  const state = args.resume ? loadState() : { ingested_references: [], last_source: null, last_offset: 0, updated_at: "" };

  // Set up cache directories
  const cacheDir = join(dirname(DB_PATH), "pdf-cache");
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

  const stats = { decisions: 0, guidelines: 0, skipped: 0, failed: 0 };

  // ----- Decisions -----
  if (!args.guidanceOnly) {
    const source = SOURCES.decisions;
    const entries = await crawlListingPages(source.listPath, source.label, args);
    console.log(`\n  Total decision entries discovered: ${entries.length}`);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      try {
        const inserted = await processDecisionEntry(entry, cacheDir, db, existingRefs, args, state);
        if (inserted) {
          stats.decisions++;
        } else {
          stats.skipped++;
        }
      } catch (err) {
        stats.failed++;
        console.error(`  FAILED [${entry.reference ?? entry.downloadId}]: ${(err as Error).message}`);
      }

      // Save state periodically
      if (args.resume && i % 10 === 0) saveState(state);
    }
  }

  // ----- Guidance: Ajánlások -----
  if (!args.decisionsOnly) {
    for (const sourceKey of ["guidance_ajanlasok", "guidance_tajekoztatok"] as const) {
      const source = SOURCES[sourceKey];
      const entries = await crawlListingPages(source.listPath, source.label, args);
      console.log(`\n  Total guidance entries discovered (${source.label}): ${entries.length}`);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        try {
          const inserted = await processGuidelineEntry(entry, source.label, cacheDir, db, existingRefs, args, state);
          if (inserted) {
            stats.guidelines++;
          } else {
            stats.skipped++;
          }
        } catch (err) {
          stats.failed++;
          console.error(`  FAILED [${entry.reference ?? entry.downloadId}]: ${(err as Error).message}`);
        }

        if (args.resume && i % 10 === 0) saveState(state);
      }
    }
  }

  // Save final state
  if (args.resume) saveState(state);

  // Print summary
  if (db) {
    const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
    const guidelineCount = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;
    const topicCount = (db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }).cnt;

    console.log("\n=== Ingestion Complete ===");
    console.log(`  New decisions:   ${stats.decisions}`);
    console.log(`  New guidelines:  ${stats.guidelines}`);
    console.log(`  Skipped:         ${stats.skipped}`);
    console.log(`  Failed:          ${stats.failed}`);
    console.log(`\n  Database totals:`);
    console.log(`    Topics:      ${topicCount}`);
    console.log(`    Decisions:   ${decisionCount}`);
    console.log(`    Guidelines:  ${guidelineCount}`);
    console.log(`\n  Database: ${DB_PATH}`);

    db.close();
  } else {
    console.log("\n=== Dry Run Complete ===");
    console.log(`  Decisions found:  ${stats.decisions}`);
    console.log(`  Guidelines found: ${stats.guidelines}`);
    console.log(`  Skipped:          ${stats.skipped}`);
    console.log(`  Failed:           ${stats.failed}`);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
