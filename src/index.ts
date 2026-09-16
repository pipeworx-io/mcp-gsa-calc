interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * GSA CALC+ ceiling labor rates — what vendors may charge per hour under GSA
 * schedule contracts, for benchmarking a labor category before you negotiate.
 *
 * Built for fleet #631.
 *
 * SOURCE. `https://api.gsa.gov/acquisition/calc/v3/api/ceilingrates/`, keyless,
 * documented at <https://open.gsa.gov/api/dx-calc-api/>. The legacy
 * `calc.gsa.gov/api/rates/` path in older write-ups is DEAD (404) — calc.gsa.gov
 * now redirects to a buy.gsa.gov landing page, and buy.gsa.gov itself serves its
 * SPA shell with HTTP 200 for every unknown path, so probing paths there returns
 * a cheerful 200 of HTML and proves nothing. Confirm against api.gsa.gov.
 *
 * MEASURED BEHAVIOUR, 2026-08-28. Everything below was probed live because the
 * documentation describes an API meaningfully different from the one running.
 *
 * 1. AN UNRECOGNISED FILTER VALUE IS SILENTLY IGNORED. `filter=worksite:Contractor`
 *    (capital C) and even `filter=nonsense_field:zzz` both return the FULL
 *    unfiltered result set with a clean 200 — identical totals to sending no
 *    filter at all. So a caller who asks for "contractor-site rates only" and
 *    gets a plausible answer back may be looking at every rate in the schedule.
 *    This is why every enum below is validated in the pack and a bad value is
 *    REFUSED rather than forwarded: the upstream will not tell us, and a wrong
 *    benchmark is worse than a refused one.
 *
 * 2. THE FILTER VOCABULARIES ARE CASE-SENSITIVE AND MUTUALLY INCONSISTENT.
 *    `worksite` matches only lowercase (`contractor`, `customer`), while
 *    `business_size` matches only uppercase (`S`, `O`) — `business_size:s`
 *    returns 0 rows, which at least fails loudly, whereas `worksite:Contractor`
 *    fails silently per (1). Three different vocabularies describe the same
 *    fields depending on where you read them: the filter takes `BA`, the JSON
 *    response says `Bachelors`, and the CSV export says `small business` where
 *    the filter wanted `S`. We accept human spellings and map them.
 *
 * 3. `min_years_experience:N` IS EXACT, NOT A MINIMUM. Despite the name,
 *    `filter=min_years_experience:5` returns only rows whose requirement is
 *    exactly 5 years (667 of 4,396 for "software engineer"). For "5 or more"
 *    the API wants `filter=experience_range:5,40` (2,565). `min_experience` on
 *    our tools means what a caller means by it, and maps to experience_range.
 *
 * 4. `page` AND `page_size` ARE BOTH IGNORED. The JSON endpoint returns exactly
 *    20 rows for every query; page=1, page=2 and page=3 return byte-identical
 *    rows, and page_size=300 returns 20. A median computed from that is a median
 *    of 20 rows out of thousands.
 *
 *    `export=y` is the way out: it returns the COMPLETE matching set as CSV
 *    (4,394 rows / 1.4 MB for "software engineer"). So this pack computes
 *    percentiles from the export — a real population statistic — and returns a
 *    bounded sample of rows alongside it. `rate_summary.based_on` always states
 *    how many rows the numbers came from, because a benchmark whose sample size
 *    you cannot see is not a benchmark.
 *
 * 5. Totals from the JSON endpoint cap at 10,000 with `relation: "gte"`. We read
 *    the count from the export instead, so it is exact.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'GSA CALC+ ceiling labor rates');
}

const BASE = 'https://api.gsa.gov/acquisition/calc/v3/api/ceilingrates/';
const UA = 'pipeworx-mcp-gsa-calc/1.0 (+https://pipeworx.io)';

/** A very broad keyword can export tens of MB; stop reading rather than OOM a worker. */
const MAX_EXPORT_BYTES = 8_000_000;
const DEFAULT_ROWS = 25;
const MAX_ROWS = 200;

// Filter vocabularies, keyed by what the UPSTREAM accepts. See note (2): these
// are case-sensitive in opposite directions, so they are written out literally
// rather than derived.
const EDUCATION: Record<string, string> = {
  hs: 'HS', 'high school': 'HS', highschool: 'HS',
  aa: 'AA', associates: 'AA', associate: 'AA', "associate's": 'AA',
  ba: 'BA', bachelors: 'BA', bachelor: 'BA', "bachelor's": 'BA', bs: 'BA',
  ma: 'MA', masters: 'MA', master: 'MA', "master's": 'MA', ms: 'MA',
};
const WORKSITE: Record<string, string> = {
  contractor: 'contractor', contractor_facility: 'contractor', 'contractor facility': 'contractor',
  customer: 'customer', customer_facility: 'customer', 'customer facility': 'customer', government: 'customer',
};
const BUSINESS_SIZE: Record<string, string> = {
  s: 'S', small: 'S', 'small business': 'S',
  o: 'O', other: 'O', large: 'O', 'other than small': 'O',
};

const ORDERING = new Set(['labor_category', 'current_price', 'vendor_name', 'education_level', 'min_years_experience']);

interface RateRow {
  labor_category: string;
  vendor_name: string;
  contract_number: string;
  schedule: string;
  sin: string;
  hourly_rate: number;
  education_level: string;
  min_years_experience: number | null;
  worksite: string;
  business_size: string;
  security_clearance: string;
  contract_end: string;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a caller's word to the upstream token, or throw naming the accepted
 * set. Throwing is the point — see note (1); forwarding an unknown value returns
 * the unfiltered population dressed as a filtered answer.
 */
function resolveEnum(value: string, table: Record<string, string>, argName: string): string {
  const hit = table[value.trim().toLowerCase()];
  if (hit) return hit;
  const accepted = [...new Set(Object.values(table))].join(', ');
  throw new Error(
    `gsa-calc: "${value}" is not a recognised ${argName}. Accepted: ${accepted} `
    + `(spellings like "bachelors" or "small business" are also accepted). `
    + `Upstream silently ignores an unknown filter and returns EVERY rate, so this is refused rather than guessed.`,
  );
}

/** Percentile by nearest-rank on a sorted ascending array. */
function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

/** Minimal RFC4180 line splitter — vendor names and category lists contain commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

interface Query {
  keyword?: string;
  search?: string;
  filters: string[];
  ordering?: string;
  sort?: string;
}

function buildUrl(q: Query, exportCsv: boolean): string {
  const p = new URLSearchParams();
  if (q.keyword) p.set('keyword', q.keyword);
  if (q.search) p.set('search', q.search);
  if (q.ordering) { p.set('ordering', q.ordering); p.set('sort', q.sort ?? 'asc'); }
  if (exportCsv) p.set('export', 'y');
  const qs = q.filters.map((f) => `filter=${encodeURIComponent(f)}`).join('&');
  return `${BASE}?${p.toString()}${qs ? `&${qs}` : ''}`;
}

async function fetchExport(q: Query): Promise<{ rows: RateRow[]; truncated: boolean }> {
  const url = buildUrl(q, true);
  // `Accept: text/csv` is REJECTED with 406 even though the response body is
  // text/csv; `*/*` is accepted and returns exactly that. Asking for the thing
  // you are given is the one request this endpoint refuses.
  const res = await pwFetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) {
    throw new Error(`gsa-calc: CALC+ returned HTTP ${res.status} for ${url}`);
  }
  let text = await res.text();
  let truncated = false;
  if (text.length > MAX_EXPORT_BYTES) {
    text = text.slice(0, MAX_EXPORT_BYTES);
    truncated = true;
  }

  const lines = text.split(/\r?\n/);
  // The export opens with a "SEARCH VALUES" preamble and the echoed query before
  // the real header, so seek the header rather than assuming line 0.
  const headerIdx = lines.findIndex((l) => l.startsWith('Contract #,'));
  if (headerIdx === -1) return { rows: [], truncated };
  const header = splitCsvLine(lines[headerIdx]);
  const col = (name: string) => header.indexOf(name);
  const iContract = col('Contract #');
  const iCat = col('Labor Category');
  const iSize = col('Business Size');
  const iSched = col('Schedule');
  const iSite = col('Site');
  const iClear = col('Security Clearance');
  const iEnd = col('End Date');
  const iSin = col('SIN');
  const iVendor = col('Vendor Name');
  const iEdu = col('Education Level');
  const iExp = col('Minimum Years Experience');
  const iPrice = col('Current Year Labor Price');

  const rows: RateRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    const rate = num(f[iPrice]);
    // A row with no current-year price cannot participate in a rate benchmark;
    // dropping it here keeps it out of the percentiles rather than as a zero.
    if (rate === null) continue;
    rows.push({
      labor_category: f[iCat] ?? '',
      vendor_name: f[iVendor] ?? '',
      contract_number: f[iContract] ?? '',
      schedule: f[iSched] ?? '',
      sin: f[iSin] ?? '',
      hourly_rate: rate,
      education_level: f[iEdu] ?? '',
      min_years_experience: num(f[iExp]),
      worksite: f[iSite] ?? '',
      business_size: f[iSize] ?? '',
      security_clearance: f[iClear] ?? '',
      contract_end: f[iEnd] ?? '',
    });
  }
  return { rows, truncated };
}

function summarise(rows: RateRow[], truncated: boolean) {
  const prices = rows.map((r) => r.hourly_rate).sort((a, b) => a - b);
  return {
    based_on: prices.length,
    // Named so nobody reads a sample as the population. `complete` is false only
    // when the export was cut at the byte cap, which is the one case where these
    // numbers describe part of the match set rather than all of it.
    complete: !truncated,
    min: pct(prices, 0),
    p25: pct(prices, 25),
    median: pct(prices, 50),
    p75: pct(prices, 75),
    max: prices.length ? Math.round(prices[prices.length - 1] * 100) / 100 : null,
    currency: 'USD',
    basis: 'ceiling hourly rate, current contract year',
  };
}

function commonFilters(args: Record<string, unknown>): string[] {
  const filters: string[] = [];

  const minExp = num(args.min_experience);
  const maxExp = num(args.max_experience);
  if (minExp !== null || maxExp !== null) {
    // See note (3): min_years_experience is an EQUALITY filter upstream, so a
    // caller asking for "5+ years" must become a range or they silently get
    // only the rows requiring exactly 5.
    filters.push(`experience_range:${minExp ?? 0},${maxExp ?? 99}`);
  }

  const minRate = num(args.min_rate);
  const maxRate = num(args.max_rate);
  if (minRate !== null || maxRate !== null) {
    filters.push(`price_range:${minRate ?? 0},${maxRate ?? 100000}`);
  }

  if (typeof args.education === 'string' && args.education.trim()) {
    const codes = args.education.split(/[|,]/).map((e) => resolveEnum(e, EDUCATION, 'education'));
    filters.push(`education_level:${[...new Set(codes)].join('|')}`);
  }
  if (typeof args.worksite === 'string' && args.worksite.trim()) {
    filters.push(`worksite:${resolveEnum(args.worksite, WORKSITE, 'worksite')}`);
  }
  if (typeof args.business_size === 'string' && args.business_size.trim()) {
    filters.push(`business_size:${resolveEnum(args.business_size, BUSINESS_SIZE, 'business_size')}`);
  }
  if (args.security_clearance !== undefined && args.security_clearance !== null) {
    const v = String(args.security_clearance).trim().toLowerCase();
    if (!['yes', 'no', 'true', 'false'].includes(v)) {
      throw new Error('gsa-calc: security_clearance must be yes or no.');
    }
    filters.push(`security_clearance:${v === 'yes' || v === 'true' ? 'yes' : 'no'}`);
  }
  return filters;
}

function ordering(args: Record<string, unknown>): { ordering?: string; sort?: string } {
  const o = typeof args.sort_by === 'string' ? args.sort_by.trim() : '';
  if (!o) return { ordering: 'current_price', sort: 'asc' };
  if (!ORDERING.has(o)) {
    throw new Error(`gsa-calc: sort_by must be one of ${[...ORDERING].join(', ')}.`);
  }
  const dir = String(args.sort_dir ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  return { ordering: o, sort: dir };
}

function limitOf(args: Record<string, unknown>): number {
  const n = num(args.limit);
  if (n === null) return DEFAULT_ROWS;
  return Math.max(1, Math.min(MAX_ROWS, Math.floor(n)));
}

function notFound(laborCategory: string, filters: string[]) {
  return {
    found: false,
    reason: 'no_matching_rates',
    labor_category: laborCategory,
    filters_applied: filters,
    hint:
      'No GSA schedule rates matched. Labor-category names are free text on the contracts '
      + '("Sr. Software Engineer", "Software Engineer III"), so try a shorter keyword — '
      + '"software engineer" rather than "senior full-stack software engineer" — or relax the filters.',
  };
}

async function laborRates(args: Record<string, unknown>, summaryOnly: boolean): Promise<unknown> {
  const category = typeof args.labor_category === 'string' ? args.labor_category.trim() : '';
  if (!category) {
    throw new Error('gsa_labor_rates requires `labor_category`, e.g. "software engineer" or "project manager".');
  }
  const filters = commonFilters(args);
  const q: Query = { keyword: category, filters, ...ordering(args) };
  const { rows, truncated } = await fetchExport(q);
  if (!rows.length) return notFound(category, filters);

  const summary = summarise(rows, truncated);
  const matched = [...new Set(rows.map((r) => r.labor_category))];
  const base = {
    found: true,
    query: category,
    filters_applied: filters,
    total_matching_rates: rows.length,
    rate_summary: summary,
    // Trap (a) from the task: the caller's words are not the contracts' words, so
    // show what actually matched — the spread of titles is itself the answer to
    // "am I benchmarking the right thing".
    matched_labor_categories: matched.slice(0, 25),
    matched_category_count: matched.length,
    source: 'GSA CALC+ ceiling rates (api.gsa.gov/acquisition/calc/v3), current contract year',
  };
  if (summaryOnly) return base;
  return { ...base, rates_returned: Math.min(rows.length, limitOf(args)), rates: rows.slice(0, limitOf(args)) };
}

async function vendorRates(args: Record<string, unknown>): Promise<unknown> {
  const vendor = typeof args.vendor === 'string' ? args.vendor.trim() : '';
  if (!vendor) {
    throw new Error('gsa_vendor_rates requires `vendor`, the company name as it appears on the contract, e.g. "DIGNITAS TECHNOLOGIES, LLC".');
  }
  const filters = commonFilters(args);
  // `search` is exact-match upstream; `keyword` is the partial one. Vendor names
  // are recorded in full legal form, so a partial keyword is the forgiving choice.
  const q: Query = { keyword: vendor, filters, ...ordering(args) };
  const { rows, truncated } = await fetchExport(q);
  const mine = rows.filter((r) => r.vendor_name.toLowerCase().includes(vendor.toLowerCase()));
  if (!mine.length) {
    return {
      found: false,
      reason: 'no_matching_vendor_rates',
      vendor,
      hint:
        rows.length
          ? `The keyword matched ${rows.length} rate(s) but none from a vendor whose name contains "${vendor}". Vendor names are recorded in full legal form — try a distinctive fragment such as "DIGNITAS".`
          : 'No rates matched at all. Try a shorter fragment of the company name.',
    };
  }
  const vendors = [...new Set(mine.map((r) => r.vendor_name))];
  return {
    found: true,
    vendor_query: vendor,
    matched_vendors: vendors,
    filters_applied: filters,
    total_matching_rates: mine.length,
    rate_summary: summarise(mine, truncated),
    rates_returned: Math.min(mine.length, limitOf(args)),
    rates: mine.slice(0, limitOf(args)),
    source: 'GSA CALC+ ceiling rates (api.gsa.gov/acquisition/calc/v3), current contract year',
  };
}

const FILTER_PROPS = {
  min_experience: { type: 'number', description: 'Minimum years of experience required, inclusive. Means "this many OR MORE" — mapped to the upstream range filter, because the upstream field of the same name is an exact match.' },
  max_experience: { type: 'number', description: 'Maximum years of experience required, inclusive.' },
  education: { type: 'string', description: 'Minimum education: HS, AA, BA or MA. Plain spellings work too ("bachelors", "high school"). Combine with | for several, e.g. "BA|MA".' },
  worksite: { type: 'string', description: 'Where the work is performed: "contractor" (vendor site) or "customer" (government site).' },
  business_size: { type: 'string', description: '"S" for small business or "O" for other than small. "small" and "large" also work.' },
  security_clearance: { type: 'string', description: '"yes" to only rates requiring a clearance, "no" to exclude them.' },
  min_rate: { type: 'number', description: 'Only rates at or above this hourly price, USD.' },
  max_rate: { type: 'number', description: 'Only rates at or below this hourly price, USD.' },
  sort_by: { type: 'string', enum: ['current_price', 'labor_category', 'vendor_name', 'education_level', 'min_years_experience'], description: 'Sort field (default current_price).' },
  sort_dir: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default asc).' },
} as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'gsa_labor_rates',
    description:
      'GSA schedule hourly labor rates for a job title — the ceiling rate vendors may charge the government under a GSA MAS contract. Use this to benchmark what a labor category costs: "typical GSA hourly rate for a project manager", "what do senior software engineers bill under MAS", "GSA schedule rate for a data scientist with 10 years experience". Returns individual rates with vendor name, contract number, SIN, education and experience requirements, plus a price summary (min, p25, median, p75, max) computed across EVERY matching rate, not just the ones returned. Filter by experience, education, worksite, business size, security clearance and price band. Example: gsa_labor_rates({ labor_category: "software engineer", min_experience: 5 })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        labor_category: { type: 'string', description: 'Job title to benchmark, e.g. "software engineer", "project manager". Partial match against contract labor categories, which are free text — prefer a short phrase over a long one.' },
        limit: { type: 'number', description: `How many individual rates to return, 1-${MAX_ROWS} (default ${DEFAULT_ROWS}). The summary always covers every matching rate regardless of this.` },
        ...FILTER_PROPS,
      },
      required: ['labor_category'],
    },
  },
  {
    name: 'gsa_rate_stats',
    description:
      'Price statistics only for a GSA schedule labor category — min, 25th percentile, median, 75th percentile and max hourly ceiling rate across every matching contract rate, with no individual rows. Use when you want the benchmark number rather than the listings: "what is the median GSA rate for a business analyst", "p75 hourly rate for cybersecurity engineers with a clearance". Same filters as gsa_labor_rates. Example: gsa_rate_stats({ labor_category: "project manager", education: "BA", min_experience: 10 })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        labor_category: { type: 'string', description: 'Job title to benchmark, e.g. "project manager".' },
        ...FILTER_PROPS,
      },
      required: ['labor_category'],
    },
  },
  {
    name: 'gsa_vendor_rates',
    description:
      'Every GSA schedule labor rate published by one contractor — what this specific company charges the government per hour, across its labor categories, with contract numbers and SINs. Use for "what rates does Booz Allen have on its GSA schedule" or to compare one vendor against the market median. Example: gsa_vendor_rates({ vendor: "DIGNITAS TECHNOLOGIES" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        vendor: { type: 'string', description: 'Company name or a distinctive fragment of it, e.g. "DIGNITAS" or "Booz Allen". Vendor names are recorded in full legal form on the contract.' },
        limit: { type: 'number', description: `How many rates to return, 1-${MAX_ROWS} (default ${DEFAULT_ROWS}).` },
        ...FILTER_PROPS,
      },
      required: ['vendor'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'gsa_labor_rates':
      return laborRates(args, false);
    case 'gsa_rate_stats':
      return laborRates(args, true);
    case 'gsa_vendor_rates':
      return vendorRates(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
