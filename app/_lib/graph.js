import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { generateSqlDecision, healSql, summarize } from "./agent";
import { validateSelectOnly, UnsafeQueryError } from "./sqlGuard";
import { executeQuery } from "./db";

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
});

// ---- Nodes -----------------------------------------------------------
// A node is just a function: (state) => partial state update.

async function generateNode(state) {
  const decision = await generateSqlDecision(state.question, state.history);
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
    return { answer: state.answer, sqlUsed: state.sqlUsed, rows: state.rows };
  }
  if (!state.needsSql || !state.sql) {
    return { answer: state.directAnswer || "I'm not sure how to help with that." };
  }
  if (state.error instanceof UnsafeQueryError) {
    return { answer: "I couldn't find an answer to that in the store's catalog." };
  }
  return { answer: "Sorry, I couldn't look that up right now. Try rephrasing your question." };
}

// ---- Edges (the routing logic) ----------------------------------------

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
  .addNode("generate", generateNode)
  .addNode("validate", validateNode)
  .addNode("execute", executeNode)
  .addNode("heal", healNode)
  .addNode("summarize", summarizeNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "generate")
  .addConditionalEdges("generate", afterGenerate, ["validate", "finalize"])
  .addConditionalEdges("validate", afterValidate, ["execute", "heal", "finalize"])
  .addConditionalEdges("execute", afterExecute, ["summarize", "heal", "finalize"])
  .addConditionalEdges("heal", afterHeal, ["validate", "finalize"])
  .addEdge("summarize", "finalize")
  .addEdge("finalize", END)
  .compile();

export async function answerQuestion(question, history = []) {
  const result = await graph.invoke({ question, history, healed: false });
  // Only expose the public shape — result also carries internal fields
  // (error, healed, needsSql, ...) that callers outside this module shouldn't see.
  return { answer: result.answer, sqlUsed: result.sqlUsed, rows: result.rows };
}
