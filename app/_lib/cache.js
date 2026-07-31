import { embedText } from "./agent";
import { query } from "./db";
import { toVectorLiteral } from "./vectorUtils";

// Phase 4 — semantic cache. Paraphrased questions ("cheapest laptop?" vs
// "what's your least expensive laptop") embed close together, so instead of
// an exact-text cache we do a nearest-neighbor search over embeddings stored
// in Postgres (pgvector) and treat anything above a similarity threshold as
// a hit. This saves both the Gemini call(s) and the database round-trip for
// repeat-ish questions.
//
// Cosine similarity = 1 - cosine distance. pgvector's `<=>` operator returns
// cosine distance directly for vector_cosine_ops indexes, so we convert.
const SIMILARITY_THRESHOLD = Number(process.env.SEMANTIC_CACHE_THRESHOLD) || 0.92;

// How long a cached answer stays eligible to be served before a lookup
// treats it as if it doesn't exist. Found the hard way during Phase 7
// testing: a "cheapest product" answer cached on day 1 kept getting served
// as-is even after a new, cheaper product was added on day 2 — nothing ever
// told the cache the underlying data had changed. This doesn't delete old
// rows (they're harmless, just ignored once stale), it just stops a lookup
// from ever selecting one past this age, so a live store's changing
// inventory can't get stuck behind a permanently-cached stale answer.
const TTL_SECONDS = Number(process.env.SEMANTIC_CACHE_TTL_SECONDS) || 3600;

// Phase 7 first tried folding conversation history into what gets embedded
// (via buildContextualQuery), to fix the known gap where a context-dependent
// follow-up could match an unrelated cached answer. That made things worse:
// consecutive follow-ups in the same conversation share almost all of their
// recent-history text, so the *shared prefix* dominated the similarity score
// and swamped the one line that actually differed — completely different
// follow-ups ("what about a cheaper one?" vs "what's the most expensive
// product?") started collapsing onto the same cached row purely because
// they followed similar prior turns. Confirmed directly against
// semantic_cache: one row hit 10 times for unrelated questions.
//
// The actual fix is simpler: a context-dependent follow-up's correct answer
// is inherently unique to its own conversation ("cheaper than *what*?"), so
// it was never a good caching candidate to begin with — skip the cache
// entirely (both lookup and storage) whenever there's real history, and
// only cache genuinely standalone questions. This also fully covers the
// original Phase 4 concern: a follow-up that's never cached can't wrongly
// match anything.

// Returns the cached { answer, sqlUsed, rows } for the closest match above
// the similarity threshold (and not older than TTL_SECONDS), or null if
// there's history to consider (see above), no good-enough fresh match, or
// the cache itself is unreachable — a cache-layer failure should never
// break the user-facing answer, so callers get a miss instead of a thrown
// error.
export async function findSimilarCached(question, history = []) {
  if (history && history.length > 0) return null;

  try {
    const embedding = await embedText(question);
    const vectorLiteral = toVectorLiteral(embedding);
    const result = await query(
      `select id, answer, sql_used, rows, 1 - (embedding <=> $1::vector) as similarity
       from semantic_cache
       where created_at > now() - make_interval(secs => $2::int)
       order by embedding <=> $1::vector
       limit 1`,
      [vectorLiteral, TTL_SECONDS]
    );

    const best = result.rows[0];
    if (!best || best.similarity < SIMILARITY_THRESHOLD) {
      return null;
    }

    // Best-effort hit-tracking; failure here shouldn't turn a cache hit into
    // a miss for the user.
    query(`update semantic_cache set hit_count = hit_count + 1, last_hit_at = now() where id = $1`, [
      best.id,
    ]).catch((err) => console.warn("Semantic cache hit-count update failed:", err.message));

    return { answer: best.answer, sqlUsed: best.sql_used, rows: best.rows };
  } catch (err) {
    console.warn("Semantic cache lookup failed, falling back to full pipeline:", err.message);
    return null;
  }
}

// Stores a freshly-computed answer for future paraphrases — only for
// standalone questions (no history); see the note above for why
// context-dependent follow-ups are deliberately never cached. Fire-and-
// forget from the caller's point of view — a failed cache write should
// never fail the request that already has a good answer to return.
export async function storeCachedAnswer({ question, history = [], answer, sqlUsed, rows }) {
  if (history && history.length > 0) return;

  try {
    const embedding = await embedText(question);
    const vectorLiteral = toVectorLiteral(embedding);
    await query(
      `insert into semantic_cache (question, embedding, answer, sql_used, rows)
       values ($1, $2::vector, $3, $4, $5)`,
      [question, vectorLiteral, answer, sqlUsed || null, rows ? JSON.stringify(rows) : null]
    );
  } catch (err) {
    console.warn("Semantic cache write failed (answer was still returned to the user):", err.message);
  }
}
