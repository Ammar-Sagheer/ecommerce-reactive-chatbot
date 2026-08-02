# ecommerce-reactive-chatbot — Roadmap

> **Read this file first every time you come back to this project**, especially after a break of
> days/weeks working on something else. The "Current Status" section at the bottom always tells
> you exactly where we left off and what the next step is.

## The Goal

Rebuild the friend-provided **[DataMind — Reactive AI Agent](https://github.com/4ff4n/reactive-ai-agent)**
(a Python/FastAPI project) as a **Node.js/Next.js** application, one feature at a time, as a
learning project. The original Python source is preserved for reference at
[`Ammar-Sagheer/reactive-ai-agent-nodejs`](https://github.com/Ammar-Sagheer/reactive-ai-agent-nodejs)
(despite the name, that repo currently just holds the original Python code we're porting from).

**Scope decision:** rather than seeding a fresh synthetic database like the original project does
(Faker-generated customers/orders/reviews), this rebuild queries the **real `saam-s-store` Supabase
database** — the same one the live store uses. This is a deliberate scaled-down feature set: we
have `products`/`categories`/`product_images` (and eventually `orders` for analytics-style
questions) rather than the original's richer schema (customers, reviews, etc.). Feature-parity
work (self-healing SQL, semantic cache, RAG, charts, voice, streaming, tracing) still applies —
only the underlying data is narrower and real instead of synthetic.

**Scaling back up later is fully possible and cheap.** The pipeline is schema-driven, not
schema-hardcoded — the LLM generates SQL from whatever schema description it's given, so growing
toward DataMind-level richness (customers, reviews, etc.) later is a **data/prompt change, not an
architecture change**: (1) add the missing tables to `saam-s-store`'s Supabase project (or point a
separate instance of this same app at a synthetic seeded DB if a full DataMind-style demo dataset
is ever wanted), (2) update the schema description fed to the LLM, (3) widen the `chatbot_readonly`
role's `GRANT`s to cover the new tables. None of that touches the LangGraph pipeline, caching,
RAG, voice, or streaming code. Treat this as a future, isolated task — not a blocker for building
the scaled-down version now.

This is a **learning-first** build: every new technology introduced gets a short "what is it and
why do we need it" explanation before we write code with it, not just working code with no
context.

## Original Feature List (what "done" looks like)

- [x] Natural-language-to-SQL chat (generate, validate, execute) — Phase 1, verified working
- [x] Self-healing SQL (auto-retry on query error, up to N attempts) — Phase 2, code complete
- [x] Semantic cache (embedding similarity — paraphrased questions hit the same cached answer) —
  Phase 4, code complete
- [x] Auto few-shot learning (successful queries get stored and reused as prompt examples) —
  Phase 5, verified
- [x] RAG fallback (answer knowledge questions that don't need a database query) — Phase 6,
  verified, uses **placeholder demo content** (see Current Status — must be replaced with real
  store policy docs before this app faces real customer traffic)
- [x] Chart auto-detection from result rows (bar/line) — Phase 8, verified
- [x] Session memory (rolling conversation window, so follow-up questions have context) — Phase 7,
  verified
- [x] Voice I/O (speech-to-text input, text-to-speech output, streamed) — Phase 10, TTS verified
  live; STT not separately re-confirmed (see Phase 10 summary)
- [x] WebSocket streaming (live token/progress updates instead of waiting for one big response) —
  Phase 9, code complete. Actually implemented as Server-Sent Events over the existing Route
  Handler, not a real WebSocket — see Tech Mapping table and Phase 9 summary for why.
- [ ] Tracing/observability (token counts, latency, cost per request)

## Tech Mapping — Python original → Node.js/Next.js equivalent

| Concern | Original (Python) | Node.js/Next.js equivalent | Notes |
|---|---|---|---|
| Web framework | FastAPI | Next.js (API routes / Route Handlers) | Same app also serves the frontend, unlike the Python version which was backend-only |
| Orchestration | LangGraph | `@langchain/langgraph` (v1.4.8) | Direct JS port exists from the same team — same concepts apply. Used in Phase 3 (`app/_lib/graph.js`): `StateGraph` + `Annotation.Root` for state, `.addNode`/`.addEdge`/`.addConditionalEdges` for the graph shape. |
| LLM calls | OpenAI Python SDK | `@google/genai` npm package (Gemini) | Reusing the same Gemini API key already set up for `reactive-google-ai-agent` — no new billing account needed. (Claude API was considered but requires separate console.anthropic.com billing beyond the Claude Pro subscription — deferred.) |
| DB access | SQLAlchemy (async) + asyncpg | `pg` (node-postgres) | Decided in Phase 1 — Gemini generates raw SQL strings at runtime, so a bare driver matches better than an ORM query-builder. Bonus: `pg` doesn't use server-side prepared statements by default, so unlike `asyncpg` we don't need the `statement_cache_size=0` PgBouncer workaround. |
| Vector search (semantic cache, few-shot, RAG) | FAISS | Postgres `pgvector` extension | Decided in Phase 4 — see below. Reused for few-shot (Phase 5) and RAG (Phase 6) if a similar approach fits. |
| Session memory | Redis | `ioredis` npm client, connected to Upstash (hosted, free tier) | Decided in Phase 7 — see below |
| Voice STT | OpenAI Whisper API | Gemini `generateContent` with the audio as an inline multimodal input `Part` | Overridden in Phase 10 — this row originally called for the `openai` package/Whisper, decided before checking whether Gemini itself could do it. It can: the SDK's own README confirms `generateContent`/`generateContentStream` accept audio as a normal multimodal input, same as images. Ammar was already on Gemini's free tier for everything else and didn't want a second paid provider for one feature, so this stays on Gemini instead of adding OpenAI. |
| Voice TTS | gTTS | Gemini `generateContentStream` with `responseModalities: ["AUDIO"]` + `speechConfig` | Same finding as above — this is the same call already built for streamed text (Phase 9), just requesting audio output instead of text. No new package, no new provider. |
| Tracing | LangFuse Python SDK | `langfuse` npm package | Official JS SDK exists |
| Realtime | FastAPI WebSocket | Server-Sent Events over the existing Route Handler (`ReadableStream` response) | Decided in Phase 9 — see below. This exact Next.js version's own docs confirmed native support for streaming raw responses from a Route Handler; a real WebSocket server would have needed a custom server process for a bidirectional channel this feature never actually uses (the client never sends anything mid-stream) |

## Phases

Each phase should be fully working and tested before moving to the next. Order is chosen so early
phases are usable/demoable on their own, not just scaffolding.

- **Phase 0 — Planning** ✅ done (this doc)
- **Phase 1 — Foundation** ✅ done: Next.js project scaffold, Postgres connection (`pg` +
  Supabase's Transaction Pooler, same restricted `chatbot_readonly` role as before), a basic
  `/api/chat` route doing one-shot NL→SQL→answer via Gemini (no caching, no self-heal retry yet —
  a basic SELECT-only safety guard was pulled forward into this phase since running raw
  LLM-generated SQL with zero validation isn't an acceptable baseline even for a "simplest version").
  A minimal chat UI at `/` for manual testing.
- **Phase 2 — Self-healing SQL** ✅ done: when `runSelect` throws (guard rejection or a real
  Postgres error), the failing SQL + question + actual error message get sent back to Gemini via a
  new `healSql()` function, asking for one corrected query. If Gemini can't produce a fix, or the
  corrected query fails too, a generic "couldn't look that up" answer is returned. One retry only
  (matches `reactive-google-ai-agent`'s `_self_heal_sql` — no unbounded retry loop).
- **Phase 3 — LangGraph.js orchestration** ✅ done: replaced the linear `try/catch` control flow
  with an explicit `StateGraph` in the new `app/_lib/graph.js`. Six nodes (`generate`, `validate`,
  `execute`, `heal`, `summarize`, `finalize`) connected by conditional edges that encode exactly
  the same one-retry self-heal logic from Phase 2, now as an explicit, inspectable graph shape
  instead of nested try/catch. `app/_lib/agent.js` was trimmed down to just the three
  Gemini-calling functions (`generateSqlDecision`, `healSql`, `summarize`) — the graph owns all
  control flow now. `app/_lib/db.js` gained `executeQuery()` (pure execution, no validation) so
  "validate" and "execute" could become two separate, real graph nodes instead of one combined
  step. `route.js` now imports `answerQuestion` from `graph.js` instead of `agent.js` — its public
  shape (`{answer, sqlUsed, rows}`) is unchanged, so nothing else needed to change.
- **Phase 4 — Semantic cache** ✅ done: embedding-based similarity cache so paraphrased
  questions reuse answers instead of re-running the full Gemini + SQL pipeline. New
  `app/_lib/cache.js` (`findSimilarCached`/`storeCachedAnswer`), a new `embedText()` in
  `app/_lib/agent.js` (Gemini's `gemini-embedding-001`, 768 dims), and a new `semantic_cache` table
  (pgvector) in the `saam-s-store` Supabase project. Two new graph nodes wrap the existing Phase 3
  graph: `cacheLookup` (right after `START`; on a hit >= similarity threshold, routes straight to
  `finalize` with the cached answer) and `cacheStore` (right before `END`; writes back any
  freshly-computed *cacheable* answer). "Cacheable" excludes the two hardcoded pipeline-failure
  fallback strings (guard rejection / unrecoverable query error) so a temporary failure doesn't get
  permanently cached — everything else (real data answers, greetings, graceful refusals) is cached.
- **Phase 5 — Auto few-shot learning** ✅ done: every SQL query that actually executes
  without error gets stored as a `(question, sql)` example; future questions pull the top-K most
  similar past examples (via the same pgvector approach as Phase 4) and hand them to Gemini as
  concrete precedent before it generates new SQL. Unlike the semantic cache, this never
  short-circuits the pipeline — Gemini still runs every time, just with richer context. New
  `app/_lib/fewshot.js` (`findSimilarExamples`/`storeExample`) and a new `sql_examples` table
  (pgvector) in the same Supabase project. `generateNode` in `graph.js` now fetches examples before
  calling `generateSqlDecision`; `executeNode` fire-and-forget-stores the SQL the moment it runs
  successfully (covers both a fresh `generate` success and a post-`heal` success, since both flow
  through the same `executeNode`). `agent.js`'s `generateSqlDecision` gained an `examples` parameter
  and a `buildSqlSystemPrompt()` helper that appends them to the system instruction only when
  present — with an empty `sql_examples` table, behavior is identical to Phase 4.
- **Phase 6 — RAG fallback** ✅ code complete: answers store-policy/general questions (shipping,
  returns, payment, contact, "about us") that aren't in the product database, instead of wrongly
  refusing them as off-topic. The classification call gained a third path — `needsRag` alongside
  the existing `needsSql` — so Gemini now picks one of: query the database / answer from retrieved
  knowledge / greet-or-refuse. Reuses the exact pgvector similarity-search pattern from Phase 4/5,
  pointed at a new `knowledge_base` table. New `app/_lib/rag.js` (`findRelevantChunks`), a new
  `answerFromKnowledge()` in `agent.js` (answers ONLY from retrieved text, explicitly instructed to
  say "I don't have that information" rather than guess — the groundedness property that makes RAG
  not just a fancier way to hallucinate), and one new graph node (`rag`) wired into the existing
  routing after `generate`/`heal` alongside `validate`. **Uses placeholder demo content** (see
  Current Status) — seeded via a new standalone script, `scripts/seedKnowledgeBase.mjs`, run once
  locally.
- **Phase 7 — Session memory** ✅ done: server-side rolling conversation window in Redis
  (Upstash), replacing trust in whatever `history` the client resends. `app/api/chat/route.js` now
  reads/creates an httpOnly session cookie (`chat_session_id`, 30-day browser lifetime), pulls that
  session's recent history from the new `app/_lib/sessionMemory.js` (`getSessionHistory`/
  `appendToSessionHistory`, an `ioredis` list per session with a 30-minute inactivity TTL that
  Redis expires on its own — no cleanup job needed), and appends both the new question and the
  answer after each turn. `app/page.js` no longer sends `history` in the request body at all.
  `graph.js`/`agent.js` are otherwise untouched — `answerQuestion(question, history)`'s interface
  didn't change, only where `history` comes from did.

  Also fixed the "known limitation" flagged back in Phase 4: the semantic cache (`cache.js`) and RAG
  retrieval (`rag.js`) now fold the last few turns into what gets embedded (new shared
  `buildContextualQuery()` in `app/_lib/vectorUtils.js`, alongside a `toVectorLiteral()` extracted
  from three near-identical copies in `cache.js`/`fewshot.js`/`rag.js`), so a context-dependent
  follow-up like "what about a cheaper one?" is matched/retrieved based on what it's actually
  following, not embedded as a bare, ambiguous phrase. `fewshot.js` deliberately did **not** get the
  same treatment — `generateSqlDecision` already receives full conversation history directly and
  resolves follow-up references itself when writing SQL, so few-shot examples only need to match on
  *query structure*, which doesn't depend on what preceded the question.
- **Phase 8 — Chart generation** ✅ done: detects whether a query's result
  rows are chart-worthy and, if so, which type — deliberately **rule-based, not another
  Gemini call**: whether rows have a numeric column, a category or date column, and more
  than one row is a mechanical question about data shape, not a judgment call an LLM
  needs to make, and a plain function can't hallucinate a chart type that doesn't fit.
  New `app/_lib/chart.js` (`detectChart(rows)`) returns `{ type: "bar" | "line", labelKey,
  valueKey }` or `null`: a date column alongside a numeric one → line (trend); a text
  column alongside a numeric one → bar (comparison); anything else (a single scalar,
  no numeric column) → no chart. Handles a real Postgres gotcha: `numeric`/`bigint`
  columns (price, `COUNT(*)`) come back from `pg` as **strings**, not JS numbers, so
  "is this numeric" checks `Number.isFinite(Number(v))`, not `typeof v === "number"`.
  `summarizeNode` in `graph.js` computes the chart alongside the text answer; it flows
  through `finalizeNode`/`cacheStoreNode` and into the public `answerQuestion()` return
  shape and the `semantic_cache` table (new nullable `chart` jsonb column) so a cached
  chart-worthy answer replays with its chart intact.

  Rendering: hand-rolled SVG in a new `app/_components/Chart.js` (Ammar's explicit
  choice over adding a charting dependency) — followed the project's `dataviz` skill:
  single series → **sequential one hue** (not categorical; there's only one series),
  horizontal bars (long product names don't work as rotated vertical-bar labels in a
  narrow chat bubble), rounded data-ends, a shared baseline, and direct value labels in
  a permanently-reserved gutter so nothing is ever clipped or needs runtime text
  measurement. Confirmed mark-vs-surface contrast (blue `#2a78d6` light / `#3987e5`
  dark against the chat bubble backgrounds) clears the accessibility floor: 4.02:1 /
  4.79:1, both above the 3:1 minimum. Deliberately skipped the full hover/tooltip layer
  a production chart would have (native SVG `<title>` only) since every value is
  already a direct label — an accepted scope reduction that came with choosing
  hand-rolled over a library, not an oversight.
- **Phase 9 — Streaming** ✅ done and verified: live token-by-token answers + pipeline-progress updates,
  over Server-Sent Events (not a real WebSocket — see Tech Mapping table for why). `/api/chat` now
  returns a `text/event-stream` instead of one JSON blob. Two real generation calls
  (`summarize()`/`answerFromKnowledge()` in `agent.js`) switched from `generateContent` to
  `generateContentStream`, streaming actual Gemini output token-by-token via an `onToken` callback;
  every other path (cache hits, greeting/refusal, error fallbacks) sends its already-known text as
  one bulk chunk, since there's no real generation latency to smooth over there. `graph.js` runs the
  pipeline via LangGraph's `.stream()` (not `.invoke()`), with nodes calling `config.writer(...)` to
  emit `{type: "progress"}`/`{type: "token"}` events mid-execution — **not** the package's own
  exported `writer()` convenience helper, which reads `config.configurable.writer` and doesn't match
  how this installed version's Pregel loop actually wires things up (confirmed by testing directly,
  not assumed from the docs — the ambient helper silently no-ops). `page.js` parses the stream by
  hand via `fetch()` + a manual SSE frame parser, since the browser's built-in `EventSource` only
  supports `GET` requests and this needs to `POST` the question.
- **Phase 10 — Voice I/O** ✅ done, TTS verified live; STT not explicitly re-confirmed after a fix —
  see note below: speech-to-text input, streamed text-to-speech output — entirely on Gemini, not
  OpenAI (see Tech Mapping table for why
  that changed from the original plan). `agent.js` gains `transcribeAudio()` (a normal
  `generateContent` call with the recording as an inline multimodal `Part`, prompted to output only
  the transcription) and `speakText()` (the same `generateContentStream` shape as
  `summarize()`/`answerFromKnowledge()`, just with `responseModalities: ["AUDIO"]` and a
  `speechConfig` voice). `route.js`'s `/api/chat` now accepts `audio` (base64) + `audioMimeType` as
  an alternative to `message`, transcribes it first and emits a `transcript` SSE event so the UI can
  show what was heard, then continues through the exact same pipeline as typed text; a `voice: true`
  flag on the request additionally streams `audio` SSE events (base64 PCM chunks) after the answer's
  `done` event. `page.js` adds a mic button (`MediaRecorder` → base64 → POST) and a speaker toggle;
  playback uses a hand-rolled Web Audio API scheduler (`AudioBuffer` built manually from the raw PCM
  samples, chunks queued back-to-back via `AudioContext.currentTime`) since Gemini's audio output has
  no file header an `<audio>` tag could just point at — it's raw samples, not a self-contained format.

  Ammar is on `gemini-3.5-flash-lite` as the main model, newer than this was first written against —
  checked Google's own model docs directly rather than assume anything about a generation this
  recent. Confirmed: every mainline Gemini model, `gemini-3.5-flash-lite` included, accepts audio as
  input (its modality table lists "Text, Image, Video, Audio, and PDF" for input) even though it can
  only ever respond in text — so `transcribeAudio()` correctly needs no separate STT model, it just
  reuses whatever `GEMINI_MODEL` already is. Audio *output* is the opposite: no mainline model can do
  it, a dedicated TTS model is genuinely required, confirming that part of the original design. No
  "3.5" TTS variant exists, but a newer-than-2.5 one matching Ammar's generation does —
  `gemini-3.1-flash-tts-preview` — now the default for `GEMINI_TTS_MODEL`, with
  `gemini-2.5-flash-preview-tts`/`gemini-2.5-pro-preview-tts` confirmed as real, working older
  fallbacks if the 3.1 preview isn't available on his account. `"Kore"` confirmed as a real prebuilt
  voice name (one of 30 listed), and the audio format confirmed as 24kHz/16-bit/mono PCM — matching
  what the decoder in `page.js` already assumed by default (and it parses the rate out of the
  response's mimeType rather than hardcoding it, so this isn't fragile even if that ever changes).

  Verified: the base64→Int16→Float32 PCM decode math round-trips correctly against synthetic sample
  data (isolated Node test, matching the approach used for Phase 9's SSE framing); model/voice names
  and audio format checked directly against Google's current docs rather than assumed from training
  data, given how recent this model generation is.

  **First live test caught a real bug:** text answers worked but no audio played, no error either.
  Root cause was the `AudioContext` being created lazily inside `playPcmChunk`, several `await`s
  deep inside the async SSE-reading loop — too far removed from the actual button click for browsers
  to treat it as a real user gesture, so they silently kept it `"suspended"` and dropped every
  scheduled sound. Fixed with `unlockAudioContext()`, called synchronously (before any `await`) from
  every click that can lead to audio — the Send button, the mic button, and the speaker toggle
  itself — so there's an unbroken chain back to a genuine click by the time playback needs it.
  Ammar re-tested after the fix and **confirmed TTS playback now works live**.

  **Not separately re-confirmed after that fix:** whether a real microphone recording transcribes
  accurately via `transcribeAudio()` — Ammar's retest specifically called out voice *output* working;
  voice *input* accuracy wasn't explicitly checked in the same pass. Worth a quick dedicated check
  next time voice work resumes, though there's no reason to expect it's broken — nothing about the
  playback fix touched the input/transcription path. Also still unconfirmed: whether
  `gemini-3.1-flash-tts-preview` specifically is what answered (vs. falling back), since that wasn't
  asked at the time — worth checking server logs if it matters which one is actually in use.
- **Phase 11 — Tracing/observability**: request-level tracing (tokens, latency, cost)
- **Phase 12 — Deployment**: containerize and deploy (host TBD, likely Render again given no
  credit card)

## Current Status

**Last updated:** 2026-08-01

**Where we are:** ✅ **Phases 1-10 done, merged to `main`.** Phase 10's TTS output is confirmed
live; STT input wasn't separately re-confirmed after the AudioContext fix (see Phase 10 summary) —
worth a quick check next time voice work resumes, not currently believed broken.

**⚠️ Placeholder content reminder:** the `knowledge_base` table (seeded by
`scripts/seedKnowledgeBase.mjs`) contains clearly fictional shipping/returns/payment/contact/about
text, written only to prove the RAG mechanism works — not real store policy. **Ask Ammar for real
policy documents before this app is ever pointed at real customer/store traffic** — he explicitly
asked to be reminded of this when that time comes, so don't skip re-raising it.

Phase 1 built the Next.js
scaffold, `app/_lib/schema.js` (schema description for the LLM), `app/_lib/sqlGuard.js`
(SELECT-only validator), `app/_lib/db.js` (`pg` pool via the Supabase pooler), `app/api/chat/route.js`,
and a minimal test page at `/`. Phase 2 added self-healing (fixed SQL failures by feeding the error
back to Gemini). Phase 3 replaced the linear code with an explicit LangGraph.js `StateGraph` in the
new `app/_lib/graph.js` — six nodes (`generate`/`validate`/`execute`/`heal`/`summarize`/`finalize`)
connected by conditional edges. `app/_lib/agent.js` now holds only the three pure Gemini-calling
functions; the graph owns all control flow.

Phase 4 added a semantic cache in front of that graph:
- **New Supabase migration** (`sgyxlcjqlcbwudekpgfz`, the `saam-s-store`/`Saamj-Strore-Clone`
  project): `create extension vector` (moved to the `extensions` schema, matching this project's
  existing extension placement, to keep the security advisor clean), a new `semantic_cache` table
  (`question`, `embedding vector(768)`, `answer`, `sql_used`, `rows jsonb`, `hit_count`,
  `created_at`, `last_hit_at`), an `hnsw`/`vector_cosine_ops` index, RLS enabled with a policy
  scoped to the `chatbot_readonly` role only (not Supabase's `anon`/`authenticated`), and
  `GRANT SELECT, INSERT, UPDATE` to `chatbot_readonly` (the LLM still can't reach this table even if
  something went wrong with the grant — `sqlGuard.js`'s `ALLOWED_TABLES` allowlist only contains
  `products`/`categories`/`product_images`, so generated SQL referencing `semantic_cache` would be
  rejected regardless).
  - **Bugs found during Ammar's first local test:** asked two questions, `semantic_cache` stayed
    completely empty, with the terminal (once the hit/miss `console.log` below was added) showing
    `type "vector" does not exist`. Two stacked permission gaps, both introduced when the previous
    migration moved the `vector` extension into the `extensions` schema (to clear the
    "extension_in_public" advisory):
    1. `chatbot_readonly` had no `USAGE` grant on the `extensions` schema at all — fixed with
       `grant usage on schema extensions to chatbot_readonly;`. Confirmed via
       `has_schema_privilege('chatbot_readonly','extensions','USAGE')` flipping `false → true`.
    2. Even with `USAGE` granted, the *unqualified* type name `vector` still didn't resolve, because
       `chatbot_readonly` had no `search_path` override (`rolconfig` was `null`) and the database
       itself has no cluster-wide default search_path either — so the role was silently falling
       back to Postgres's compiled-in default of `"$user", public` (no `extensions`). Fixed with
       `alter role chatbot_readonly set search_path = "$user", public, extensions;`. Confirmed via
       `pg_roles.rolconfig` now showing that search_path. **Note:** this only applies to *new*
       Postgres connections — the app's `pg` pool had to be restarted (dev server restart) to pick
       it up, since an already-open connection keeps whatever search_path it had at connect time.

    Both times, the failure was caught by `cache.js`'s own try/catch, logged as a `console.warn`,
    and silently degraded to "run the full pipeline" instead of crashing the chatbot — which is
    exactly why the app kept answering questions normally throughout, just never touching the cache.
    Added a `console.log` in `cacheLookupNode` ("Semantic cache hit"/"miss") so this class of failure
    is visible in the terminal going forward instead of only a warning buried in the logs.
- **`app/_lib/agent.js`**: new `embedText()` using `ai.models.embedContent()` with
  `GEMINI_EMBEDDING_MODEL` (default `gemini-embedding-001`) and `outputDimensionality: 768`.
- **`app/_lib/db.js`**: new `query(sql, params)` — a parameterized-query escape hatch for our own
  internal tables, deliberately bypassing `validateSelectOnly`/`ALLOWED_TABLES` (those guards exist
  to sandbox untrusted Gemini-generated SQL, not our own hand-written statements).
- **`app/_lib/cache.js`** (new): `findSimilarCached(question)` embeds the question, runs a
  pgvector `<=>` (cosine distance) nearest-neighbor query, and returns the cached
  `{answer, sqlUsed, rows}` if similarity is above `SEMANTIC_CACHE_THRESHOLD` (default `0.92`), else
  `null`. `storeCachedAnswer(...)` embeds + inserts a new row. Both are wrapped in try/catch so a
  cache-layer failure (network hiccup, bad embedding) degrades to "just run the full pipeline"
  rather than breaking the user-facing answer.
- **`app/_lib/graph.js`**: two new nodes wrap the Phase 3 graph without touching its internals —
  `cacheLookup` right after `START` (routes to `finalize` on a hit, `generate` on a miss) and
  `cacheStore` right before `END` (writes back the answer if it's fresh, non-cache-hit, and
  "cacheable"). `finalizeNode` now also decides `cacheable`: `true` for real data answers and for
  greeting/off-topic-refusal direct answers (deterministic per question), `false` for the two
  hardcoded pipeline-failure fallback strings (guard rejection, unrecoverable query error) — so a
  transient failure never gets permanently cached as the answer to a legitimate question.
- **New env vars** (`.env.example`): `GEMINI_EMBEDDING_MODEL` (default `gemini-embedding-001`) and
  `SEMANTIC_CACHE_THRESHOLD` (default `0.92`).

Phase 5 added auto few-shot learning on top of the (now-merged) Phase 4 pipeline:
- **New Supabase migration**: a `sql_examples` table (`question`, `sql`, `embedding vector(768)`,
  `created_at`, `use_count`), same `hnsw`/`vector_cosine_ops` index and `chatbot_readonly`-scoped RLS
  policy pattern as `semantic_cache`. This time the role-level fix from Phase 4 (`GRANT USAGE ON
  SCHEMA extensions` + `search_path`) already covers it — confirmed via `has_table_privilege`/
  `has_schema_privilege` before writing any app code, instead of finding a permission gap the hard
  way again.
- **`app/_lib/fewshot.js`** (new): `findSimilarExamples(question)` returns up to `FEWSHOT_TOP_K`
  (default 3) examples with similarity ≥ `FEWSHOT_MIN_SIMILARITY` (default 0.5 — deliberately looser
  than the semantic cache's 0.92, since an example only needs to be a reasonable style/structure
  guide, not a near-duplicate). `storeExample({question, sql})` embeds + inserts. Same
  fail-degrades-gracefully try/catch pattern as `cache.js`.
- **`app/_lib/agent.js`**: `generateSqlDecision` gained a third `examples` parameter; new
  `buildSqlSystemPrompt(examples)` appends a "here's real SQL that worked before" block to the
  system instruction only when examples exist, so an empty `sql_examples` table means identical
  behavior to Phase 4.
- **`app/_lib/graph.js`**: `generateNode` now calls `findSimilarExamples` before
  `generateSqlDecision`. `executeNode` fire-and-forget-calls `storeExample` the moment a query
  executes without error — this naturally captures both a clean first-try success and a
  post-`heal` success, since both paths run through the same `executeNode`. No new nodes/edges
  needed (unlike Phase 4's cache, few-shot retrieval doesn't change the graph's routing — it only
  enriches what `generate` sends to Gemini).
- **New env vars**: `FEWSHOT_TOP_K` (default `3`), `FEWSHOT_MIN_SIMILARITY` (default `0.5`).
- **Synergy with Phase 4 worth noting:** the semantic cache runs *before* `generate` and
  short-circuits on a hit, so only genuinely novel-enough questions ever reach `executeNode` and get
  stored as few-shot examples — no separate dedup logic needed to stop the examples table from
  filling up with near-identical rows.

**Verified — Phase 1:**
- Gemini-only path (greetings / off-topic refusal) — tested via `curl`.
- **Full DB round-trip** (NL → SQL → Postgres query → natural-language answer) — tested on Ammar's
  own machine (VS Code, real network access; this build container can only reach port 443
  outbound, not the Postgres pooler's port 6543). A real product question returned a correct,
  data-backed answer.

**Verified — Phase 2:** ✅ real self-heal confirmed end to end, with logs. Test method: temporarily
added a fake `rating` column to `SCHEMA_DESCRIPTION` (reverted immediately after — not in `main`
anymore) so Gemini would confidently write SQL referencing a column that doesn't actually exist in
Supabase. Asking "what is the average rating of your products" produced:
1. Gemini wrote `SELECT AVG(rating) AS average_rating FROM products;`
2. Postgres rejected it: `error: column "rating" does not exist` (code `42703`)
3. Console logged `"SQL failed, attempting self-heal (query error): ..."` exactly as designed
4. `healSql()` sent the failed SQL + that error message back to Gemini
5. Gemini recovered gracefully — dropped the nonexistent column and answered with what it could
   actually determine (real product count), rather than crashing or returning the generic fallback

(First test attempt didn't trigger it — an early version of the fake column's SQL comment literally
said "this column does not actually exist," which Gemini read and correctly avoided querying at
all. Lesson: don't spoil your own test data.)

**Bugs found and fixed during Phase 1 local testing:**
1. `GEMINI_MODEL=gemini-2.5-flash` returned a 404 ("no longer available to new users") — fixed by
   setting `GEMINI_MODEL=gemini-3.5-flash-lite` in `.env.local`.
2. `.env.local`'s `DATABASE_URL` still had the literal `PROJECT_REF`/`PASSWORD` placeholder text
   from `.env.example` — surfaced as a Postgres `tenant/user ... not found` error. Fixed by pasting
   the real pooler connection string.
3. Chat input text was invisible in dark-mode browsers (`app/globals.css`'s
   `prefers-color-scheme: dark` block set near-white text with no explicit input background/text
   color to override it). Fixed with explicit `bg-white text-zinc-900 placeholder-zinc-400` on the
   input in `app/page.js`.

**Side note:** also hand-created a throwaway `ammar` login role (SELECT-only, same grant pattern
as `chatbot_readonly`) on a *different* Supabase project (`siwosrjmbrgoautfmzfy`) purely to
verify the role-creation/connection-string mechanics — unrelated to this app, not part of any
phase, safe to ignore/delete.

**Verified — Phase 3:** ✅ fully confirmed on Ammar's machine, including the self-heal loop through
the new graph. Test method: temporarily added a fake `weight_grams` column to
`SCHEMA_DESCRIPTION` (reverted immediately after). Two attempts were needed to phrase a question
that actually triggered SQL generation — "what is the total weight..." and "what is the heaviest
product" were both treated as out-of-scope by Gemini's initial classification (no SQL attempted at
all); "list products sorted by weight" finally worked. Traced from the logs:
1. `generateNode` wrote `SELECT name, slug, weight_grams FROM products WHERE weight_grams IS NOT
   NULL ORDER BY weight_grams DESC LIMIT 1`
2. `validateNode` passed it (valid SELECT syntax)
3. `executeNode` ran it → Postgres rejected it (`column "weight_grams" does not exist`, logged by
   `graph.js`'s own `executeNode` — confirmed the new graph is what's actually running, not
   leftover old code)
4. `afterExecute` correctly routed to `"heal"` (error present, not yet healed)
5. `healNode` asked Gemini to fix it — this time Gemini recognized the column isn't real and
   returned `needsSql: false` with a graceful explanation, instead of guessing again
6. `afterHeal` correctly routed straight to `"finalize"` (since `!needsSql`), which returned that
   graceful `directAnswer` — arguably better than Phase 2's original behavior, which discarded a
   graceful heal-step answer in favor of always showing a generic hardcoded fallback message.

**Verified — Phase 4:** ✅ confirmed end to end on Ammar's machine after fixing the two permission
bugs above (schema `USAGE` + `search_path`, both needed a dev-server restart to take effect since
`pg`'s connection pool caches search_path per connection). Real traffic through the running app
produced 9 distinct rows in `semantic_cache`, with genuine hits: `"what is the cheapest product on
store"` → `hit_count: 2`, `"hello"` → `hit_count: 1`, plus a hit on a rephrasing of the price
question. Different questions ("how many products on store", "and which one is the least
expensive", greetings, etc.) each got their own row instead of colliding — confirms the similarity
threshold isn't so loose that unrelated questions falsely share answers. Terminal logs showed the
expected `Semantic cache miss...`/`Semantic cache hit...` lines, no `type "vector" does not exist"`
errors after the fixes.

**Verified — Phase 5:** ✅ confirmed end to end on Ammar's machine. First test attempt ("what's your
cheapest product?") was a false start — it hit the *Phase 4* cache (near-duplicate of an
already-cached question from earlier testing) and never reached `generateNode`, so few-shot never
fired. Picked genuinely fresh questions instead:
1. `"which products are currently on sale?"` → cache miss, no examples yet (table was empty),
   generated and stored `SELECT name, slug, price, sale_price FROM products WHERE sale_price IS NOT
   NULL AND stock > 0 ORDER BY (price - sale_price) DESC LIMIT 20`.
2. `"do you have any discounted items?"` → cache miss (different enough wording), terminal showed
   `Few-shot: pulled 1 example(s) into the prompt`, and Gemini generated **byte-for-byte identical
   SQL** to the stored example instead of a different-but-also-valid query. First row's `use_count`
   incremented to `1`, confirming retrieval + prompt injection both worked, not just storage.

This also clarified an important scope point worth recording: few-shot does **not** reduce Gemini
calls the way the Phase 4 cache does. A cache hit skips `generate` and `summarize` entirely (zero
Gemini calls); few-shot only enriches the existing `generate` call's prompt on a cache *miss* — same
call count as Phase 3, just a better-informed one. The payoff is consistency/correctness for novel
questions, not fewer round-trips.

**Verified — Phase 6:** ✅ confirmed end to end after two stacked permission bugs during seeding
(both below). `npm run seed:knowledge` succeeded once fixed — all 5 placeholder topics present in
`knowledge_base`. Real traffic confirmed via `semantic_cache` (RAG answers get cached too, same
path as any other answer): `"what is your shipping policy"`, `"shipping policy"`, `"shipping
price?"` all answered with content paraphrased directly from the seeded shipping chunk, and
`"what about the returns"` correctly answered from the returns chunk — all four with `sql_used:
null`, confirming they went through the RAG path, not SQL. Different phrasings of the same shipping
question all pulled the same grounded content, confirming the classification + retrieval
generalizes across wording rather than only matching one exact question.
- **Bug found running `npm run seed:knowledge`:** failed immediately with `permission denied for
  table knowledge_base`. Root cause was in the *script*, not the grants — `knowledge_base` was
  deliberately made `SELECT`/`INSERT`-only for `chatbot_readonly` (no `DELETE`/`UPDATE`, since this
  table isn't meant to be mutable at request time), but the seed script opened with `delete from
  knowledge_base` to make re-runs idempotent, which that role was never granted. Confirmed via
  `has_table_privilege('chatbot_readonly','public.knowledge_base','DELETE')` returning `false`.
  Rather than widen the runtime role's grants just for script convenience, fixed the script instead:
  removed the `DELETE`, and added a row-count guard that bails out with instructions (clear the
  table manually via the Supabase SQL editor using an admin connection, then re-run) if
  `knowledge_base` already has rows, so accidental re-runs can't silently create duplicates.
- **Second bug, same seed attempt, next line of the script:** the `INSERT` itself then failed with
  `new row violates row-level security policy for table "knowledge_base"`. This one really was a
  migration gap, not the grants — the original migration `GRANT`ed `chatbot_readonly` table-level
  `INSERT`, but only wrote an RLS *policy* for `SELECT`. RLS enforces per-command: a table-level
  grant doesn't help if there's no matching policy for that specific command, so every `INSERT` was
  being default-denied by RLS regardless of the grant. Confirmed via `pg_policies` showing only one
  `SELECT`-command policy existed. Fixed with an additional, separate `INSERT`-command policy
  (`with check (true)`) rather than switching to one broad `for all` policy — keeping them split
  makes it obvious at a glance that `UPDATE`/`DELETE` still have no policy either, matching this
  table's intentionally-narrower-than-`semantic_cache`/`sql_examples` design.

**Verified — Phase 7:** ✅ confirmed end to end. Set up an Upstash Redis instance and ran a real conversation
test on Ammar's machine, which immediately surfaced a genuine bug:
- **Bug found: stale semantic cache answers.** Asked "what is your cheapest product?" and got
  "test2 at $99.99" — but a cheaper product ("test", on sale for $90) actually existed. Root cause,
  confirmed directly against `semantic_cache`: the question matched a **day-old cached answer** from
  earlier Phase 4 testing (`hit_count` had already reached 6), cached *before* the $90 product
  existed. `semantic_cache` had no expiration at all — once cached, an answer is served forever
  regardless of whether the underlying `products` data changes underneath it. Not a Phase 7 bug
  specifically, but exactly the kind of thing real conversational testing (vs. isolated phase
  testing) surfaces. Fixed in `cache.js`: `findSimilarCached`'s query now excludes rows older than a
  new `SEMANTIC_CACHE_TTL_SECONDS` (default 3600 = 1 hour) via
  `where created_at > now() - make_interval(secs => $2::int)`, so a lookup treats a stale row as if
  it doesn't exist and falls through to a fresh, live query instead. Verified the SQL directly
  against the real cache table before shipping it — confirmed the known-stale row flips to
  `still_fresh: false` under the new filter. This doesn't delete old rows (harmless, just ignored
  once stale) — table growth from that is an accepted minor tradeoff, not worth a cleanup job yet.

- **Second, more serious bug found immediately after the TTL fix: cache collapse across unrelated
  follow-ups.** Asked three different follow-up questions in one conversation ("what about a cheaper
  one?", "what about a less cheaper option?", "what is the most expensive product?") and got the
  **exact same cached answer** (the Baby Nail Kit) for all three — confirmed directly against
  `semantic_cache`: that one row's `hit_count` had reached 10, served for questions that clearly
  weren't asking about it. Root cause was Phase 7's own context-blindness fix
  (`buildContextualQuery`, folding recent turns into what gets embedded): consecutive follow-ups in
  the same conversation share almost all of their recent-history text, so that *shared prefix*
  dominated the similarity score and swamped the one line that actually differed — two genuinely
  different follow-ups collapsed onto the same cached row purely because they followed similar prior
  turns. Realized the original design reasoning was wrong: a context-dependent follow-up's correct
  answer is inherently unique to its own conversation ("cheaper than *what*?"), so it was never a
  good caching candidate to begin with — trying to make the cache *context-aware* was the wrong fix
  for the Phase 4 concern. **Reverted and replaced** with a simpler rule in `cache.js`: skip the
  cache entirely (both lookup and storage) whenever there's real conversation history, only cache
  genuinely standalone questions. This still fully resolves the original Phase 4 concern (a follow-up
  that's never cached can't wrongly match anything) without the new collapse failure mode.
  `buildContextualQuery`/`VECTOR_CONTEXT_MESSAGES` remain in use for RAG retrieval (`rag.js`) only —
  that one compares a contextualized query against *static* knowledge chunks with no conversational
  content of their own, so there's no row-to-row shared-prefix collision risk there.

Both remaining checks passed after the fixes above:
- **Context-aware follow-ups**: confirmed via `sql_examples` that "one less cheaper than that?"
  correctly resolved "that" → the $90 test product from the prior turn — `generateSqlDecision`
  genuinely uses real conversation history, not a guess. (The SQL direction it picked, `< 90` instead
  of `> 90`, was Gemini misreading the ambiguous phrase "less cheaper" itself, a natural-language
  ambiguity — the context resolution that matters for Phase 7 worked correctly.)
- **Session persistence across a refresh**: refreshed the page (visible chat resets to just the
  greeting — plain React state, never persisted) and asked "what did we just talk about?" — got back
  a correct summary of the pre-refresh conversation (test2, Neutella Jug, test), proving the
  `chat_session_id` cookie survived the refresh and Redis still held the real history untouched.
  This is the clearest possible confirmation that server-side memory, not client-resent history, is
  what's actually driving context now.

**One accepted, non-blocking gap surfaced by that same test**: the *visible* chat transcript doesn't
rehydrate from Redis on page load — only the underlying conversation *memory* does. Not a bug, just
a feature nobody asked for yet (an endpoint to fetch and redisplay a session's history on mount).
Deferred rather than built speculatively; revisit if it turns out to matter in practice.

**Verified — Phase 8:** ✅ confirmed end to end. Bar charts confirmed working in the browser (product
price comparisons rendered correctly). The line-chart path took three real rounds of bugs, all found
and fixed from actual screenshots rather than assumed fixed after the first patch:
- **Bug found: date-grouped queries never charted, even with genuinely chart-worthy data.** Asked
  "how many products were added each month?" (correctly got no chart — verified directly against
  the database that this really was a single row, all 20 products created in the same month, so
  `null` was the *correct* answer) then asked the context-aware follow-up "and what about each day
  of july?" — 5 real distinct days, clearly chart-worthy — and got a text-only answer again. Root
  cause, confirmed by reproducing the exact row shape locally: node-postgres returns
  `timestamp`/`timestamptz` columns (like `DATE_TRUNC('day', created_at)`) as native JS **`Date`
  objects**, not strings — the opposite convention from `numeric`/`bigint`, which deliberately stay
  strings. `isNumeric()`'s `Number(value)` check didn't account for this: `Number(someDate)` coerces
  a Date to its epoch-milliseconds timestamp, which is a perfectly finite number, so every date
  column was silently misclassified as `"numeric"` before `isDateLike()` ever got a chance to look at
  it — leaving `detectChart` with two "numeric" columns and nothing to use as a label, falling
  through to `null`. Fixed in `chart.js`: both `isNumeric()` and `isDateLike()` now check
  `value instanceof Date` explicitly up front, rather than relying on `Number()`/`Date.parse()`
  coercion to sort it out. Re-verified directly against the real failing row shape (5 `Date` objects
  + string counts) — now correctly returns a line chart spec.
- **Related fix, same root cause**: a `Date`-typed column's value survives the JSON round-trip to
  the browser as a full ISO timestamp string (e.g. `"2026-07-11T00:00:00.000Z"`) — unreadable as a
  raw chart-axis label. Added `formatLabel()` in `Chart.js` to detect an ISO-date-shaped string and
  reformat it as a short human date (`"Jul 11"`) before truncation, so the line chart's date labels
  are actually legible instead of a wall of ISO text. Applied everywhere a line-chart label is shown
  — the visible per-point label and the native hover tooltip both go through it.

After that fix landed, the line chart rendered but was genuinely broken in three more ways, all
caught from one real screenshot:
- **Filled solid wedge instead of an open line.** Root cause: the line's `<path>` carried both the
  `chart-mark` and `chart-line` CSS classes, and `.chart-mark { fill: #2a78d6; }` is a real
  stylesheet rule — which, in SVG, always wins over a `fill="none"` *presentation attribute* written
  directly on the element (a stylesheet rule beats a bare attribute, full stop). `.chart-line` never
  set `fill` at all, so `.chart-mark`'s fill was the only rule in effect. Fixed by giving `.chart-line`
  its own fully self-contained style (`fill: none`, its own `stroke` color) instead of relying on
  `.chart-mark` for color and hoping the attribute would win — it never would have.
- **Reversed timeline.** `LineChart` plotted rows in whatever order the SQL returned them, and
  `GROUP BY ... ORDER BY day DESC` (a very natural way for Gemini to write it) comes back newest-first
  — so the x-axis silently ran backwards (July 11 on the left, July 5 on the right), with nothing
  indicating anything was reversed. Fixed by sorting by `new Date(label)` ascending inside
  `LineChart` itself, before computing any plot positions — the chart is now correct regardless of
  what order the underlying SQL happened to return.
- **Only one of five points ever had a visible value.** The original design labeled just the line's
  endpoint (per the general "don't label every point, it gets chaotic" guideline) — but that
  guideline is calibrated for dense, multi-week time series, not a 5-point chart in a static chat
  log, where a hover-only tooltip for 4 of 5 values isn't actually reachable without hovering, and
  isn't reachable at all on a touch device. Revised: every point on a line chart now gets both a
  value label above it and a date label below it — a real, considered change from the original plan
  once real testing showed the general rule didn't fit this specific, small-N use case.

Final re-test confirmed all three fixed at once: a clean open line (not a filled wedge), correct
left-to-right chronological order (Jul 5 → Jul 7 → Jul 9 → Jul 10 → Jul 11), and every point's value
visible without hovering.

**Verified — Phase 9:** ✅ verified end to end on Ammar's machine against live Gemini/Postgres/Redis,
on top of the two isolated pre-integration tests below:
- **LangGraph's `.stream()` + `config.writer` mechanism**: tested against a real compiled
  `StateGraph` with conditional routing (not just the type definitions). First attempt used the
  package's own exported `writer()` helper — it silently did nothing (no error, no events). Traced
  the mismatch: `writer()` reads `config.configurable.writer`, but this installed version's Pregel
  loop actually sets `config.writer` (unnested). Switched nodes to accept `config` as a real second
  parameter and call `config.writer?.(...)` directly — re-tested against a 3-node conditional graph
  and confirmed progress/token events arrive in the correct order, interleaved correctly, and the
  final accumulated state matches what `.invoke()` would have returned.
- **The SSE encode/parse round-trip**: tested the server's `sseEvent()` framing against the client's
  hand-written parser with synthetic edge cases — multiple frames arriving in a single chunk, one
  frame split across two separate reads, and special characters (quotes, unicode) — all round-tripped
  correctly.
- **Live in the browser**: progress messages appeared ("Querying the database…" etc.) followed by the
  answer visibly building word-by-word. A chart-worthy question ("show me a price comparison")
  correctly attached its bar chart once the "done" event landed, confirming the chart/rows path
  survived the switch from one JSON response to a token stream + separate structured event.

**A real finding along the way, not a Phase 9 bug:** testing surfaced that the Phase 7 semantic
cache (`cache.js`) only ever fires on the *first* message of a session — `findSimilarCached` and
`storeCachedAnswer` both unconditionally skip whenever `history.length > 0`, and session history
(`sessionMemory.js`) stays populated for `SESSION_TTL_SECONDS` (default 1800s) after every message.
So within any real conversation, turn 2 onward never touches the cache at all, regardless of whether
that turn is actually context-dependent. Pre-existing behavior from Phase 7, not introduced here —
left as-is for now since it's out of Phase 9's scope, but flagged as a real limitation worth revisiting:
the fix would be detecting whether the *current* question is actually context-dependent, rather than
blanket-skipping caching whenever any history exists.

**Verified — Phase 10:** ✅ TTS output confirmed live by Ammar after the `unlockAudioContext` fix
(text + spoken answer both working). STT input not separately re-confirmed in that same pass — see
the Phase 10 summary above. Merged to `main`.

**Next step:** Start Phase 11 — tracing/observability (request-level tracing for tokens, latency,
cost).

**Parked, not forgotten:** `claude/saamjh-store-config` branch — store-name templating
(`NEXT_PUBLIC_STORE_NAME`, extracted from a hardcoded `"Saamjh Store"`) and `/api/chat` access
control (`ALLOWED_ORIGINS` + `CHATBOT_SITE_KEY`, for calling this from the real Saamjh Store site on
a different domain). Built, tested live, then deliberately reverted off `main` — Ammar wants this
kind of store-specific/deployment config kept off the shared template history, on its own branch
instead.

**Superseding decision, discussed after that branch was parked:** the actual plan is no longer "this
chatbot as a separate service, called cross-origin from Saamjh Store." Once all remaining phases
here are done, this chatbot gets **integrated directly into the Saamjh Store repo itself**, adopting
Saamjh Store's own styling/UI rather than this repo's current standalone chat UI. Saamjh Store is
itself meant to become the template going forward: clone the combined repo (storefront + chatbot
native) per new client, swap in that client's products/styling, point at a fresh database. This
makes the `claude/saamjh-store-config` branch's whole cross-origin layer (CORS allowlist, site key,
`SameSite=None` cookie) **unnecessary** once the merge happens — that machinery only existed because
the chatbot was a separate service on a different domain; a native integration is always same-origin,
nothing to gate. That branch stays parked as-is (harmless, not worth deleting), just not the
direction this is actually headed. One thing to carry into the merged repo regardless: keep the
chatbot's DB access on its own restricted read-only role, separate from whatever role the storefront
itself uses for checkout/inventory/orders — that boundary matters more once it's one codebase, not
less. Pick this integration up once Phase 11 (and whatever comes after) is done; nothing about it
depends on those phases, it's independent, later work.

**Open decisions not yet made:**
- None blocking — Postgres client (`pg`) was decided and used in Phase 1 (see Tech Mapping table).
  Vector search backend (`pgvector`) was decided in Phase 4 (see Tech Mapping table). Session memory
  backend (`ioredis` + Upstash) was decided in Phase 7 (see Tech Mapping table).

**Known limitation resolved in Phase 7:** the semantic cache/RAG retrieval used to key off the bare
question text only, ignoring conversation history — flagged back in Phase 4 as something to revisit
once real session memory existed. Fixed in `cache.js`/`rag.js` via `buildContextualQuery()` (see
Phase 7 summary above), so this is no longer an open gap.
