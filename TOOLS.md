# Tools Reference

All tools use the `hu_dp_` prefix. Every response includes a `_meta` field with disclaimer, data age, copyright, and source URL.

## hu_dp_search_decisions

Full-text search across NAIH decisions (határozatok, bírságok, figyelmeztetések).

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | yes | Full-text search query |
| type | enum | no | Filter: `bírság`, `figyelmeztetés`, `határozat`, `tájékoztató` |
| topic | string | no | Filter by topic ID (see `hu_dp_list_topics`) |
| limit | number | no | Max results (default 20, max 100) |

**Response:** `{ results: Decision[], count: number, _meta }` — each result includes `_citation`.

---

## hu_dp_get_decision

Fetch a single NAIH decision by reference number.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| reference | string | yes | NAIH reference (e.g., `NAIH-2021-1234`, `NAIH/2022/123`) |

**Response:** Full decision object with `_citation` and `_meta`.

---

## hu_dp_search_guidelines

Search NAIH guidance documents (tájékoztatók, iránymutatások, állásfoglalások).

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | yes | Full-text search query |
| type | enum | no | Filter: `tájékoztató`, `iránymutatás`, `állásfoglalás`, `útmutató` |
| topic | string | no | Filter by topic ID |
| limit | number | no | Max results (default 20, max 100) |

**Response:** `{ results: Guideline[], count: number, _meta }` — each result includes `_citation`.

---

## hu_dp_get_guideline

Fetch a single NAIH guidance document by database ID.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | number | yes | Database ID (from search results) |

**Response:** Full guideline object with `_citation` and `_meta`.

---

## hu_dp_list_topics

List all indexed data protection topics with Hungarian and English names.

**Arguments:** none

**Response:** `{ topics: Topic[], count: number, _meta }`

---

## hu_dp_list_sources

List all data sources indexed by this server.

**Arguments:** none

**Response:** `{ sources: Source[], _meta }`

---

## hu_dp_check_data_freshness

Check when the indexed data was last refreshed and whether it may be stale.

**Arguments:** none

**Response:** `{ status, note, source_url, recommendation, _meta }`

---

## hu_dp_about

Return server metadata: version, description, coverage summary, and full tool list.

**Arguments:** none

**Response:** Server metadata object with `_meta`.

---

## Response Metadata (`_meta`)

Every successful response includes:

```json
{
  "_meta": {
    "disclaimer": "Informational only — not legal advice...",
    "data_age": "Periodically scraped from naih.hu...",
    "copyright": "© Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH)...",
    "source_url": "https://naih.hu/"
  }
}
```

## Citation Metadata (`_citation`)

`get_*` and `search_*` results include per-item `_citation`:

```json
{
  "_citation": {
    "canonical_ref": "NAIH-2021-1234",
    "display_text": "NAIH-2021-1234",
    "source_url": "https://naih.hu/...",
    "lookup": {
      "tool": "hu_dp_get_decision",
      "args": { "reference": "NAIH-2021-1234" }
    }
  }
}
```

## Error Responses

Errors include `_error_type` for programmatic handling:

```json
{
  "error": "Decision not found: NAIH-2021-9999",
  "_error_type": "not_found"
}
```

| `_error_type` | Meaning |
|---------------|---------|
| `not_found` | Requested item does not exist in the index |
| `validation_error` | Invalid arguments |
| `internal_error` | Unexpected server error |
| `unknown_tool` | Tool name not recognised |
| `tool_error` | Generic tool execution error |
