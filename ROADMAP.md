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

This is a **learning-first** build: every new technology introduced gets a short "what is it and
why do we need it" explanation before we write code with it, not just working code with no
context.

## Original Feature List (what "done" looks like)

- [ ] Natural-language-to-SQL chat (generate, validate, execute)
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
| DB access | SQLAlchemy (async) + asyncpg | `pg` (node-postgres) or an ORM (Drizzle/Prisma) — TBD when we reach Phase 1 | |
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
- **Phase 1 — Foundation**: Next.js project scaffold, Postgres connection, a basic `/api/chat`
  route that does one-shot NL→SQL→answer (no caching, no self-heal yet — the simplest possible
  working version)
- **Phase 2 — Self-healing SQL**: retry logic when a generated query fails, plus a SQL safety
  guard (SELECT-only enforcement, same idea as `sql_guard.py` in the earlier Python backend)
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

**Last updated:** 2026-07-24

**Where we are:** Phase 0 complete. Repo created and connected, roadmap written. Nothing built
yet.

**Next step:** Start Phase 1 — scaffold the Next.js project and get a basic one-shot NL-to-SQL
chat endpoint working against the `saam-s-store` Supabase database, with a short intro to Next.js
API routes and the chosen Postgres client before writing the code.

**Decided:**
- **LLM:** Gemini, reusing the existing `reactive-google-ai-agent` API key.
- **Database:** the real `saam-s-store` Supabase project, not a fresh synthetic one. Phase 1 will
  reuse the same restricted `chatbot_readonly` role/pattern from `reactive-google-ai-agent`
  (SELECT-only on `products`/`categories`/`product_images`), extending scope later (e.g. `orders`)
  only if a phase actually needs it.

**Open decisions not yet made:**
- Which Postgres client/ORM to use in Node (plain `pg` vs an ORM like Drizzle) — decided in Phase 1
