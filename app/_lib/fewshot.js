import { embedText } from "./agent";
import { query } from "./db";

// Phase 5 — auto few-shot learning. Every time a generated SQL query
// actually runs successfully, we store the (question, sql) pair. On future
// questions we pull the most similar past examples and hand them to Gemini
// as concrete precedent — "here's how a similar question was correctly
// turned into SQL before" — instead of asking it to generate cold every
// time. Same pgvector similarity-search approach as Phase 4's cache.js, but
// this table stores *how to query*, not *the final answer*, so it doesn't
// short-circuit the pipeline the way a cache hit does — Gemini still runs,
// just with better context.
const TOP_K = Number(process.env.FEWSHOT_TOP_K) || 3;
// Lower than the semantic cache's threshold on purpose: an example only
// needs to be a reasonably relevant style/structure guide, not a
// near-duplicate of the current question.
const MIN_SIMILARITY = Number(process.env.FEWSHOT_MIN_SIMILARITY) || 0.5;

function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

// Returns up to TOP_K { question, sql } examples similar enough to be
// useful, or [] if the table is empty, nothing clears the similarity floor,
// or the lookup itself fails — a broken few-shot store should degrade to
// "generate with no examples" (today's Phase 4 behavior), never break the
// request.
export async function findSimilarExamples(question) {
  try {
    const embedding = await embedText(question);
    const vectorLiteral = toVectorLiteral(embedding);
    const result = await query(
      `select id, question, sql, 1 - (embedding <=> $1::vector) as similarity
       from sql_examples
       order by embedding <=> $1::vector
       limit $2`,
      [vectorLiteral, TOP_K]
    );

    const examples = result.rows.filter((row) => row.similarity >= MIN_SIMILARITY);
    if (examples.length > 0) {
      const ids = examples.map((row) => row.id);
      query(`update sql_examples set use_count = use_count + 1 where id = any($1::uuid[])`, [
        ids,
      ]).catch((err) => console.warn("Few-shot use-count update failed:", err.message));
    }

    return examples.map((row) => ({ question: row.question, sql: row.sql }));
  } catch (err) {
    console.warn("Few-shot example lookup failed, generating with no examples:", err.message);
    return [];
  }
}

// Stores a successfully-executed (question, sql) pair for future reuse.
// Called right after a query runs without error — never awaited by the
// caller, since a failed write here shouldn't delay or fail a request that
// already has its data.
export async function storeExample({ question, sql }) {
  try {
    const embedding = await embedText(question);
    const vectorLiteral = toVectorLiteral(embedding);
    await query(`insert into sql_examples (question, sql, embedding) values ($1, $2, $3::vector)`, [
      question,
      sql,
      vectorLiteral,
    ]);
  } catch (err) {
    console.warn("Few-shot example write failed:", err.message);
  }
}
