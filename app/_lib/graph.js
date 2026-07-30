import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { generateSqlDecision, healSql, summarize } from "./agent";
import { validateSelectOnly, UnsafeQueryError } from "./sqlGuard";
import { executeQuery } from "./db";
import { findSimilarCached, storeCachedAnswer } from "./cache";
import { findSimilarExamples, storeExample } from "./fewshot";

// The shape of the state every node reads from and writes back to.
// Each Annotation() field defaults to "last write wins" — a node returning
// { sql: "..." } just overwrites state.sql, leaving every other field alone.
const StateAnnotation = Annotation.Root({
  question: Annotation(),
  history: Annotation(),
  needsSql: Annotation(),
  sql: Annotation(),
  directAnswer: Annotation(),
  rows: Annotation(),
  error: Annotation(),
  healed: Annotation(), // true once we've already tried self-healing once
  answer: Annotation(),
  sqlUsed: Annotation(),
  fromCache: Annotation(), // true once cacheLookup found a hit — skip re-storing it
  cacheable: Annotation(), // whether finalize's answer is worth writing to the cache
});

// ---- Nodes -----------------------------------------------------------
// A node is just a function: (state) => partial state update.

async function cacheLookupNode(state) {
  const cached = await findSimilarCached(state.question);
  if (!cached) {
    console.log("Semantic cache miss, running full pipeline:", state.question);
    return { fromCache: false };
  }
  console.log("Semantic cache hit:", state.question);
  return { ...cached, fromCache: true };
}

async function generateNode(state) {
  const examples = await findSimilarExamples(state.question);
  const decision = await generateSqlDecision(state.question, state.history, examples);
  return {
    needsSql: decision.needsSql,
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

async function executeNode(state) {
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

async function healNode(state) {
  const healed = await healSql(state.question, state.sql, state.error.message);
  return {
    needsSql: healed.needsSql,
    sql: healed.sql,
    directAnswer: healed.directAnswer,
    healed: true,
    error: null,
  };
}

async function summarizeNode(state) {
  const answer = await summarize(state.question, state.rows);
  return { answer, sqlUsed: state.sql };
}

function finalizeNode(state) {
  if (state.answer) {
    // Either a fresh summarize() answer or a cache hit passed straight
    // through — either way it's already a good, deterministic answer.
    return { answer: state.answer, sqlUsed: state.sqlUsed, rows: state.rows, cacheable: true };
  }
  if (!state.needsSql || !state.sql) {
    // Greeting / off-topic refusal — deterministic for a given question, so
    // still worth caching even though it never touched the database.
    return { answer: state.directAnswer || "I'm not sure how to help with that.", cacheable: true };
  }
  if (state.error instanceof UnsafeQueryError) {
    return {
      answer: "I couldn't find an answer to that in the store's catalog.",
      cacheable: false,
    };
  }
  return {
    answer: "Sorry, I couldn't look that up right now. Try rephrasing your question.",
    cacheable: false,
  };
}

async function cacheStoreNode(state) {
  if (state.fromCache || !state.cacheable) return {};
  await storeCachedAnswer({
    question: state.question,
    answer: state.answer,
    sqlUsed: state.sqlUsed,
    rows: state.rows,
  });
  return {};
}

// ---- Edges (the routing logic) ----------------------------------------

function afterCacheLookup(state) {
  return state.fromCache ? "finalize" : "generate";
}

function afterGenerate(state) {
  return !state.needsSql || !state.sql ? "finalize" : "validate";
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
  return !state.needsSql || !state.sql ? "finalize" : "validate";
}

// ---- Build and compile the graph --------------------------------------

const graph = new StateGraph(StateAnnotation)
  .addNode("cacheLookup", cacheLookupNode)
  .addNode("generate", generateNode)
  .addNode("validate", validateNode)
  .addNode("execute", executeNode)
  .addNode("heal", healNode)
  .addNode("summarize", summarizeNode)
  .addNode("finalize", finalizeNode)
  .addNode("cacheStore", cacheStoreNode)
  .addEdge(START, "cacheLookup")
  .addConditionalEdges("cacheLookup", afterCacheLookup, ["generate", "finalize"])
  .addConditionalEdges("generate", afterGenerate, ["validate", "finalize"])
  .addConditionalEdges("validate", afterValidate, ["execute", "heal", "finalize"])
  .addConditionalEdges("execute", afterExecute, ["summarize", "heal", "finalize"])
  .addConditionalEdges("heal", afterHeal, ["validate", "finalize"])
  .addEdge("summarize", "finalize")
  .addEdge("finalize", "cacheStore")
  .addEdge("cacheStore", END)
  .compile();

export async function answerQuestion(question, history = []) {
  const result = await graph.invoke({ question, history, healed: false });
  // Only expose the public shape — result also carries internal fields
  // (error, healed, needsSql, ...) that callers outside this module shouldn't see.
  return { answer: result.answer, sqlUsed: result.sqlUsed, rows: result.rows };
}
