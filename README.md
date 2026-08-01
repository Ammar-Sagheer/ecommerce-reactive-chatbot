# ecommerce-reactive-chatbot

A Next.js rebuild of [DataMind — Reactive AI Agent](https://github.com/4ff4n/reactive-ai-agent) (a
Python/FastAPI project), built one feature at a time as a learning project. It's a chatbot for an
e-commerce storefront that answers questions about products, prices, and store policies by
generating and running SQL against a real Postgres product catalog, grounding policy questions in
retrieved store documents (RAG), and streaming both text and voice responses back live.

**Read [`ROADMAP.md`](./ROADMAP.md) first.** It's the actual source of truth for this project — the
full goal, every technical decision made and why, a phase-by-phase build history, and a "Current
Status" section that always says exactly what's done, what's verified, and what's next. This README
is just a quick orientation; ROADMAP.md has the real detail.

## What it does

- Ask a question in the chat UI (typed or spoken via the mic button) and get back a natural-language
  answer, streamed live token-by-token as it's generated — not a wait-then-dump.
- Product/price/stock questions get answered by an LLM-generated SQL query against the real catalog,
  with a self-healing retry if the first query fails, and a semantic cache so paraphrased repeat
  questions skip the round-trip entirely.
- Store-policy questions (shipping, returns, payment, contact) get answered from retrieved store
  documents (RAG), not the database.
- Chart-worthy answers (comparisons, trends over time) render as an inline bar or line chart.
- Optionally speaks the answer back out loud, using the same streaming pipeline.

## Getting started

1. Copy `.env.example` to `.env.local` and fill in real values — see that file's comments for what
   each one does and where it comes from (Postgres/Supabase, Gemini, Redis/Upstash).
2. Install dependencies and run the dev server:

   ```bash
   npm install
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000).

## Stack

Next.js (App Router) · `@langchain/langgraph` for pipeline orchestration · Gemini (`@google/genai`)
for generation, embeddings, transcription, and text-to-speech · Postgres/`pgvector` via Supabase for
the product catalog and vector search (semantic cache, few-shot examples, RAG) · Redis (Upstash) for
session memory.

See the Tech Mapping table in `ROADMAP.md` for the full original-Python → Node.js mapping and the
reasoning behind each choice.
