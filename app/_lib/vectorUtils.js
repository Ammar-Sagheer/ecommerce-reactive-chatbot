// Shared helpers for the pgvector-based similarity features spanning
// Phases 4-7: the semantic cache, few-shot examples, and RAG knowledge
// retrieval all embed text and talk to pgvector the same way.

export function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

// Folds the last few turns of conversation into the text that gets
// embedded, so a context-dependent follow-up ("what about a cheaper one?")
// is disambiguated by what it's actually following, instead of being
// embedded as a bare, ambiguous phrase on its own. With no history (a fresh
// conversation), this is just the question itself — unchanged behavior for
// the common case.
export function buildContextualQuery(question, history, turns) {
  if (!history || history.length === 0) return question;

  const recent = history
    .slice(-turns)
    .map((turn) => `${turn.role === "user" ? "Visitor" : "Assistant"}: ${turn.content}`)
    .join("\n");

  return `${recent}\nVisitor: ${question}`;
}
