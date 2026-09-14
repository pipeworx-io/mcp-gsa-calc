# gsa-calc

GSA CALC+ ceiling labor rates — the maximum hourly price a vendor may charge the
US government for a labor category under a GSA schedule contract. Used to
benchmark rates before negotiating.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1573+ live data sources.

## Tools

| Tool | What it answers |
|---|---|
| `gsa_labor_rates` | "What do senior software engineers bill under MAS?" — individual rates with vendor, contract number and SIN, plus a price summary |
| `gsa_rate_stats` | "What is the median GSA rate for a project manager?" — the summary only |
| `gsa_vendor_rates` | "What rates does this contractor have on its schedule?" |

Filters on all three: `min_experience` / `max_experience`, `education`,
`worksite`, `business_size`, `security_clearance`, `min_rate` / `max_rate`,
`sort_by` / `sort_dir`.

## Auth

None. `api.gsa.gov/acquisition/calc/v3` is keyless — no api.data.gov key is
needed, unlike `gsa-auctions` and `gsa_perdiem` which do use
`PLATFORM_DATAGOV_KEY`.

## Data sources

- CALC+ Quick Rate API — <https://open.gsa.gov/api/dx-calc-api/>
- Endpoint: `https://api.gsa.gov/acquisition/calc/v3/api/ceilingrates/`
- Rates come from GSA MAS contracts; the figure is the **ceiling** rate for the
  current contract year, not a negotiated or paid price.

The older `calc.gsa.gov/api/rates/` path found in pre-2026 write-ups is dead
(404). `calc.gsa.gov` now redirects to a landing page on `buy.gsa.gov`.

## Upstream behaviour worth knowing

All measured live on 2026-08-28. The running API differs from its documentation
in ways that change answers, so they are listed rather than assumed.

**An unrecognised filter value is silently ignored.** `filter=worksite:Contractor`
(capital C) and `filter=nonsense_field:zzz` each return the *complete unfiltered
result set* with HTTP 200 — the same total as sending no filter at all. A caller
who asks for contractor-site rates and gets a confident answer may be reading
every rate in the schedule. **This pack validates every enum and refuses an
unknown value** rather than forwarding it; the error names the accepted set. A
refused call is recoverable, a silently unfiltered benchmark is not.

**The vocabularies are case-sensitive in opposite directions, and there are
three of them.** `worksite` matches lowercase only (`contractor`); `Contractor`
is ignored. `business_size` matches uppercase only (`S`); `s` returns zero rows.
And the same field is spelled differently depending on where you read it —
filter `BA`, JSON response `Bachelors`, CSV export `small business` for filter
`S`. The pack accepts human spellings (`"bachelors"`, `"small business"`,
`"contractor facility"`) and maps them.

**`min_years_experience` is an equality filter, not a minimum.** Upstream,
`min_years_experience:5` returns only rows requiring exactly 5 years (667 of
4,396 for "software engineer"). Our `min_experience` means what a caller means
by it — 5 or more — and maps to `experience_range:5,99` (2,561 rows, with
requirements from 5 to 15+ years).

**`page` and `page_size` are both ignored.** The JSON endpoint returns exactly 20
rows for every query; `page=1`, `page=2` and `page=3` return byte-identical rows,
and `page_size=300` returns 20. `export=y` returns the complete matching set as
CSV instead, so this pack computes percentiles from the export — `based_on` in
every `rate_summary` states how many rows the numbers came from. The JSON
endpoint's own total caps at 10,000 with `relation: "gte"`; the export count is
exact.

**`Accept: text/csv` returns 406.** The export responds `Content-Type: text/csv`,
but asking for that type is the one request it refuses. Send `*/*`.

## Reading the result

`rate_summary` is computed over **every matching rate**, not the rows returned —
`based_on` is the row count behind it and `complete` is false only if a very
broad query hit the pack's byte cap. `matched_labor_categories` shows which
contract titles the keyword actually hit, because labor-category names are free
text on the contracts ("Sr. Software Engineer" vs "Software Engineer III") and
the spread tells you whether you are benchmarking the right thing.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gsa-calc": {
      "url": "https://gateway.pipeworx.io/gsa-calc/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/gsa-calc/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1573+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "gsa-calc": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-gsa-calc"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-gsa-calc
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Gsa Calc data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
