import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { generateSqlDecision, healSql, summarize, answerFromKnowledge } from "./agent";
import { validateSelectOnly, UnsafeQueryError } from "./sqlGuard";
import { executeQuery } from "./db";
import { findSimilarCached, storeCachedAnswer } from "./cache";
import { findSimilarExamples, storeExample } from "./fewshot";
import { findRelevantChunks } from "./rag";
import { detectChart } from "./chart";

// The shape of the state every node reads from and writes back to.
// Each Annotation() field defaults to "last write wins" — a node returning
// { sql: "..." } just overwrites state.sql, leaving every other field alone.
const StateAnnotation = Annotation.Root({
  question: Annotation(),
  history: Annotation(),
  needsSql: Annotation(),
  needsRag: Annotation(),
  sql: Annotation(),
  directAnswer: Annotation(),
  rows: Annotation(),
  error: Annotation(),
  healed: Annotation(), // true once we've already tried self-healing once
  answer: Annotation(),
  sqlUsed: Annotation(),
  fromCache: Annotation(), // true once cacheLookup found a hit — skip re-storing it
  cacheable: Annotation(), // whether finalize's answer is worth writing to the cache
  chart: Annotation(), // { type, labelKey, valueKey } if the rows are chart-worthy, else undefined
});

// ---- Nodes -----------------------------------------------------------
// A node is a function: (state, config) => partial state update. `config`
// is LangGraph's per-node run config; `config.writer`, when streaming with
// streamMode "custom", is how a node emits an event *while it's still
// running* instead of only after it returns. (The package also exports an
// ambient `writer()` helper meant to read this off `config.configurable`,
// but that doesn't match how this installed version's Pregel loop actually
// sets it — confirmed by testing directly — so nodes here take `config` as
// a real parameter and call `config.writer?.(...)` instead.)

async function cacheLookupNode(state) {
  const cached = await findSimilarCached(state.question, state.history);
  if (!cached) {
    console.log("Semantic cache miss, running full pipeline:", state.question);
    return { fromCache: false };
  }
  console.log("Semantic cache hit:", state.question);
  return { ...cached, fromCache: true };
}

async function generateNode(state, config) {
  config.writer?.({ type: "progress", message: "Thinking about how to answer…" });
  const examples = await findSimilarExamples(state.question);
  console.log(
    examples.length > 0
      ? `Few-shot: pulled ${examples.length} example(s) into the prompt for: ${state.question}`
      : `Few-shot: no similar examples found for: ${state.question}`
  );
  const decision = await generateSqlDecision(state.question, state.history, examples);
  return {
    needsSql: decision.needsSql,
    needsRag: decision.needsRag,
    sql: decision.sql,
    directAnswer: decision.directAnswer,
    error: null,
  };
}

async function validateNode(state) {
  try {
    const safeSql = validateSelectOnly(state.sql);
    return { sql: safeSql, error: null };
  } catch (err) {
    console.warn("SQL rejected by guard:", err.message, "| sql:", state.sql);
    return { error: err };
  }
}

async function executeNode(state, config) {
  config.writer?.({ type: "progress", message: "Querying the database…" });
  try {
    const rows = await executeQuery(state.sql);
    // Fire-and-forget: this SQL just proved it runs against the real schema,
    // regardless of whether the heal loop was needed to get here, so it's
    // worth remembering for future similar questions. storeExample() never
    // throws, so this can't fail the request.
    storeExample({ question: state.question, sql: state.sql });
    return { rows, error: null };
  } catch (err) {
    console.error("Query execution failed:", err, "| sql:", state.sql);
    return { error: err };
  }
}

async function healNode(state, config) {
  config.writer?.({ type: "progress", message: "That didn't work — trying a corrected query…" });
  const healed = await healSql(state.question, state.sql, state.error.message);
  return {
    needsSql: healed.needsSql,
    needsRag: healed.needsRag,
    sql: healed.sql,
    directAnswer: healed.directAnswer,
    healed: true,
    error: null,
  };
}

async function ragNode(state, config) {
  config.writer?.({ type: "progress", message: "Looking up store information…" });
  const chunks = await findRelevantChunks(state.question, state.history);
  console.log(
    chunks.length > 0
      ? `RAG: grounding answer in ${chunks.length} knowledge chunk(s) for: ${state.question}`
      : `RAG: no relevant knowledge found for: ${state.question}`
  );
  const answer = await answerFromKnowledge(state.question, chunks, (piece) =>
    config.writer?.({ type: "token", text: piece })
  );
  return { answer };
}

async function summarizeNode(state, config) {
  config.writer?.({ type: "progress", message: "Writing your answer…" });
  const answer = await summarize(state.question, state.rows, (piece) =>
    config.writer?.({ type: "token", text: piece })
  );
  const chart = detectChart(state.rows);
  if (chart) console.log(`Chart: detected a ${chart.type} chart (${chart.labelKey}/${chart.valueKey})`);
  return { answer, sqlUsed: state.sql, chart };
}

function finalizeNode(state, config) {
  if (state.answer) {
    // A fresh summarize()/answerFromKnowledge() answer already streamed its
    // own tokens as it generated — a cache hit never went through either of
    // those, so it never emitted anything; send it as one bulk chunk so the
    // client still gets a token event to render, regardless of which path
    // produced the answer.
    if (state.fromCache) config.writer?.({ type: "token", text: state.answer });
    return {
      answer: state.answer,
      sqlUsed: state.sqlUsed,
      rows: state.rows,
      chart: state.chart,
      cacheable: true,
    };
  }
  if (!state.needsSql || !state.sql) {
    // Greeting / off-topic refusal — deterministic for a given question, so
    // still worth caching even though it never touched the database. Never
    // streamed (it's a plain field from the structured decision call, not a
    // freeform generation call), so emit it whole.
    const answer = state.directAnswer || "I'm not sure how to help with that.";
    config.writer?.({ type: "token", text: answer });
    return { answer, cacheable: true };
  }
  if (state.error instanceof UnsafeQueryError) {
    const answer = "I couldn't find an answer to that in the store's catalog.";
    config.writer?.({ type: "token", text: answer });
    return { answer, cacheable: false };
  }
  const answer = "Sorry, I couldn't look that up right now. Try rephrasing your question.";
  config.writer?.({ type: "token", text: answer });
  return { answer, cacheable: false };
}

async function cacheStoreNode(state) {
  if (state.fromCache || !state.cacheable) return {};
  await storeCachedAnswer({
    question: state.question,
    history: state.history,
    answer: state.answer,
    sqlUsed: state.sqlUsed,
    rows: state.rows,
    chart: state.chart,
  });
  return {};
}

// ---- Edges (the routing logic) ----------------------------------------

function afterCacheLookup(state) {
  return state.fromCache ? "finalize" : "generate";
}

function afterGenerate(state) {
  if (state.needsSql && state.sql) return "validate";
  if (state.needsRag) return "rag";
  return "finalize";
}

function afterValidate(state) {
  if (state.error) return state.healed ? "finalize" : "heal";
  return "execute";
}

function afterExecute(state) {
  if (state.error) return state.healed ? "finalize" : "heal";
  return "summarize";
}

function afterHeal(state) {
  if (state.needsSql && state.sql) return "validate";
  if (state.needsRag) return "rag";
  return "finalize";
}

// ---- Build and compile the graph --------------------------------------

const graph = new StateGraph(StateAnnotation)
  .addNode("cacheLookup", cacheLookupNode)
  .addNode("generate", generateNode)
  .addNode("validate", validateNode)
  .addNode("execute", executeNode)
  .addNode("heal", healNode)
  .addNode("rag", ragNode)
  .addNode("summarize", summarizeNode)
  .addNode("finalize", finalizeNode)
  .addNode("cacheStore", cacheStoreNode)
  .addEdge(START, "cacheLookup")
  .addConditionalEdges("cacheLookup", afterCacheLookup, ["generate", "finalize"])
  .addConditionalEdges("generate", afterGenerate, ["validate", "rag", "finalize"])
  .addConditionalEdges("validate", afterValidate, ["execute", "heal", "finalize"])
  .addConditionalEdges("execute", afterExecute, ["summarize", "heal", "finalize"])
  .addConditionalEdges("heal", afterHeal, ["validate", "rag", "finalize"])
  .addEdge("rag", "finalize")
  .addEdge("summarize", "finalize")
  .addEdge("finalize", "cacheStore")
  .addEdge("cacheStore", END)
  .compile();

// Phase 9 — runs the graph via .stream() instead of .invoke(), so progress
// and token events (emitted by nodes calling config.writer(), above) reach
// the caller in real time instead of only after the whole pipeline
// finishes. `onEvent` is called with each { type: "progress" | "token", ... }
// chunk as it happens. "values" mode alongside "custom" gives a full state
// snapshot after every node — not needed by the caller, just kept as the
// running "latest known state" so the final one (once the loop ends) is
// exactly what .invoke() would have returned, for the caller to persist
// afterward (session history, semantic cache).
export async function streamAnswer(question, history, onEvent) {
  const stream = await graph.stream(
    { question, history, healed: false },
    { streamMode: ["custom", "values"] }
  );

  let finalState = {};
  for await (const [mode, data] of stream) {
    if (mode === "values") {
      finalState = data;
    } else if (mode === "custom") {
      onEvent(data);
    }
  }

  // Only expose the public shape — finalState also carries internal fields
  // (error, healed, needsSql, ...) that callers outside this module shouldn't see.
  return {
    answer: finalState.answer,
    sqlUsed: finalState.sqlUsed,
    rows: finalState.rows,
    chart: finalState.chart,
  };
}
