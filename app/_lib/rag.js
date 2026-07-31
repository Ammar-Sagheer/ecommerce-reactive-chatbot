import { embedText } from "./agent";
import { query } from "./db";
import { toVectorLiteral, buildContextualQuery } from "./vectorUtils";

// Phase 6 — RAG fallback. Retrieves the most relevant chunks of store
// knowledge (shipping/returns/payment/contact/etc.) for a question, so
// answerFromKnowledge() in agent.js can ground its answer in real text
// instead of guessing. Same pgvector similarity-search pattern as Phase
// 4/5, pointed at a different, read-only, admin-curated table.
const TOP_K = Number(process.env.RAG_TOP_K) || 3;
const MIN_SIMILARITY = Number(process.env.RAG_MIN_SIMILARITY) || 0.5;

// Phase 7 — same reasoning as the semantic cache: a bare follow-up like
// "what about exchanges instead?" doesn't mention "return" or "policy" on
// its own, so retrieval needs the preceding turns folded in to find the
// right chunk at all.
const CONTEXT_MESSAGES = Number(process.env.VECTOR_CONTEXT_MESSAGES) || 4;

// Returns up to TOP_K { topic, content } chunks similar enough to be worth
// grounding an answer in, or [] if the table is empty, nothing clears the
// similarity floor, or the lookup fails — a broken knowledge base should
// degrade to "I don't have that information" (handled by
// answerFromKnowledge on an empty array), never break the request.
export async function findRelevantChunks(question, history = []) {
  try {
    const embedding = await embedText(buildContextualQuery(question, history, CONTEXT_MESSAGES));
    const vectorLiteral = toVectorLiteral(embedding);
    const result = await query(
      `select topic, content, 1 - (embedding <=> $1::vector) as similarity
       from knowledge_base
       order by embedding <=> $1::vector
       limit $2`,
      [vectorLiteral, TOP_K]
    );

    return result.rows
      .filter((row) => row.similarity >= MIN_SIMILARITY)
      .map((row) => ({ topic: row.topic, content: row.content }));
  } catch (err) {
    console.warn("RAG knowledge lookup failed, answering with no context:", err.message);
    return [];
  }
}
