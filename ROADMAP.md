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
- [ ] Self-healing SQL (auto-retry on query error, up to N attempts)
- [ ] Semantic cache (embedding similarity — paraphrased questions hit the same cached answer)
- [ ] Auto few-shot learning (successful queries get stored and reused as prompt examples)
- [ ] RAG fallback (answer knowledge questions that don't need a database query)
- [ ] Chart auto-detection from result rows (bar/line)
- [ ] Session memory (rolling conversation window, so follow-up questions have context)
- [ ] Voice I/O (speech-to-text input, text-to-speech output, streamed)
- [ ] WebSocket streaming (live token/progress updates instead of waiting for one big response)
- [ ] Tracing/observability (token counts, latency, cost per request)

## Tech Mapping — Python original → Node.js/Next.js equivalent

| Concern | Original (Python) | Node.js/Next.js equivalent | Notes |
|---|---|---|---|
| Web framework | FastAPI | Next.js (API routes / Route Handlers) | Same app also serves the frontend, unlike the Python version which was backend-only |
| Orchestration | LangGraph | `@langchain/langgraph` | Direct JS port exists from the same team — same concepts apply |
| LLM calls | OpenAI Python SDK | `@google/genai` npm package (Gemini) | Reusing the same Gemini API key already set up for `reactive-google-ai-agent` — no new billing account needed. (Claude API was considered but requires separate console.anthropic.com billing beyond the Claude Pro subscription — deferred.) |
| DB access | SQLAlchemy (async) + asyncpg | `pg` (node-postgres) | Decided in Phase 1 — Gemini generates raw SQL strings at runtime, so a bare driver matches better than an ORM query-builder. Bonus: `pg` doesn't use server-side prepared statements by default, so unlike `asyncpg` we don't need the `statement_cache_size=0` PgBouncer workaround. |
| Vector search (semantic cache, few-shot, RAG) | FAISS | TBD — options: Postgres `pgvector` extension, or a Node vector lib | Decided per-phase, not up front |
| Session memory | Redis | `ioredis` or `redis` npm client | Same tool, just the JS client |
| Voice STT | OpenAI Whisper API | `openai` npm package (same API) | |
| Voice TTS | gTTS | TBD — no exact equivalent, will evaluate options in that phase | |
| Tracing | LangFuse Python SDK | `langfuse` npm package | Official JS SDK exists |
| Realtime | FastAPI WebSocket | Next.js + a WebSocket solution (TBD — Next.js API routes don't natively support long-lived WebSocket servers) | Decided in the streaming phase |

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
- **Phase 2 — Self-healing SQL**: retry logic when a generated query fails (the safety guard
  itself already landed in Phase 1 — see above)
- **Phase 3 — LangGraph.js orchestration**: refactor Phase 1/2's linear code into an explicit
  state graph (classify → generate → validate → execute → heal → finalize), introducing LangGraph
  concepts properly
- **Phase 4 — Semantic cache**: embedding-based similarity cache so paraphrased questions reuse
  answers
- **Phase 5 — Auto few-shot learning**: store successful query examples, inject top-K similar
  ones into future prompts
- **Phase 6 — RAG fallback**: answer non-SQL knowledge questions from a document source
- **Phase 7 — Session memory**: Redis-backed rolling conversation window
- **Phase 8 — Chart generation**: auto-detect chart type from result rows
- **Phase 9 — WebSocket streaming**: live token-by-token + pipeline-progress updates
- **Phase 10 — Voice I/O**: speech-to-text input, streamed text-to-speech output
- **Phase 11 — Tracing/observability**: request-level tracing (tokens, latency, cost)
- **Phase 12 — Deployment**: containerize and deploy (host TBD, likely Render again given no
  credit card)

## Current Status

**Last updated:** 2026-07-26

**Where we are:** ✅ **Phase 1 complete and fully verified.** Built: Next.js scaffold,
`app/_lib/schema.js` (schema description for the LLM, matching `saam-s-store`'s real
`products`/`categories`/`product_images` tables), `app/_lib/sqlGuard.js` (SELECT-only validator),
`app/_lib/db.js` (`pg` pool via the Supabase pooler), `app/_lib/agent.js` (Gemini SQL-decision +
summarize, ported from `reactive-google-ai-agent`'s `agent.py`), `app/api/chat/route.js`, and a
minimal test page at `/`.

**Verified:**
- Gemini-only path (greetings / off-topic refusal) — tested via `curl` against local `npm run dev`.
- **Full DB round-trip** (NL → SQL → Postgres query → natural-language answer) — tested on Ammar's
  own machine (VS Code, real network access, unlike this build container which can only reach
  port 443 outbound and can't reach the Postgres pooler's port 6543). A real product question
  returned a correct, data-backed answer.

**Bugs found and fixed during local testing:**
1. `GEMINI_MODEL=gemini-2.5-flash` returned a 404 ("no longer available to new users") — fixed by
   setting `GEMINI_MODEL=gemini-3.5-flash-lite` in `.env.local` (matches the model already used in
   `reactive-google-ai-agent`).
2. `.env.local`'s `DATABASE_URL` still had the literal `PROJECT_REF`/`PASSWORD` placeholder text
   from `.env.example` instead of the real Supabase project ref/password — surfaced as a Postgres
   `tenant/user ... not found` error. Fixed by pasting the real pooler connection string.
3. Chat input text was invisible when the browser/OS was in dark mode — `app/globals.css`'s
   `prefers-color-scheme: dark` block sets the page's default text color to near-white, and the
   `<input>` had no explicit background/text color of its own, so it inherited near-white text on
   its own white background. Fixed in `app/page.js` by giving the input explicit
   `bg-white text-zinc-900 placeholder-zinc-400` classes so it no longer depends on inherited
   page-level theme colors.

**Side note:** also hand-created a throwaway `ammar` login role (SELECT-only, same grant pattern
as `chatbot_readonly`) on a *different* Supabase project (`siwosrjmbrgoautfmzfy`) purely to
verify the role-creation/connection-string mechanics — unrelated to this app, not part of any
phase, safe to ignore/delete.

**Next step:** Start Phase 2 (self-healing SQL) — add retry logic so that when Gemini generates a
SQL query that fails (syntax error, wrong column name, etc.), the app automatically asks Gemini to
fix it using the actual database error message, up to a small retry limit — mirroring
`reactive-google-ai-agent`'s `_self_heal_sql` function.

**Open decisions not yet made:**
- None blocking — Postgres client (`pg`) was decided and used in Phase 1 (see Tech Mapping table).
