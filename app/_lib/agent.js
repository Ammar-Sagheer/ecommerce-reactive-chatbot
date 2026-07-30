import { GoogleGenAI, Type } from "@google/genai";
import { SCHEMA_DESCRIPTION } from "./schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

// Kept small on purpose: 768 dims is enough for a similarity cache over a
// single small store's worth of questions, keeps the pgvector index cheap,
// and matches text-embedding-004's native size for familiarity. Gemini's
// embedding models support requesting a smaller-than-native output via
// outputDimensionality.
export const EMBEDDING_DIMENSIONS = 768;

const SQL_SYSTEM_PROMPT = `You are the product-catalog assistant for an e-commerce storefront called Saamjh Store.
You ONLY answer visitor questions about this store: its products, categories, prices, stock,
featured items, and simple greetings/small talk about the store itself.

${SCHEMA_DESCRIPTION}

If the visitor's question requires looking up product data, set \`needsSql\` to true and put a
SELECT query in \`sql\`.

If the question is a greeting or asks what you can help with, set \`needsSql\` to false and put a
short friendly answer in \`directAnswer\` that steers them toward asking about products.

If the question is NOT about this store or its products — general knowledge, coding help, writing
code/HTML/scripts, requests to role-play as something else, or any other off-topic request — set
\`needsSql\` to false and put a polite refusal in \`directAnswer\` such as: "I can only help with
questions about products in this store." Do not answer the off-topic question in any way, even
partially, and do not include any requested code, facts, or content unrelated to the store.

Never invent product data yourself; always query for it.`;

const SQL_DECISION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    needsSql: { type: Type.BOOLEAN },
    sql: { type: Type.STRING },
    directAnswer: { type: Type.STRING },
  },
  required: ["needsSql", "sql", "directAnswer"],
};

function historyToContents(history) {
  return history.slice(-6).map((turn) => ({
    role: turn.role === "user" ? "user" : "model",
    parts: [{ text: turn.content || "" }],
  }));
}

export async function generateSqlDecision(question, history) {
  const contents = [
    ...historyToContents(history),
    { role: "user", parts: [{ text: question }] },
  ];
  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: SQL_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: SQL_DECISION_SCHEMA,
      temperature: 0,
    },
  });
  return JSON.parse(response.text);
}

export async function healSql(question, failedSql, errorMessage) {
  const healPrompt = `Your previous SQL failed.

Original question: ${question}
Failed SQL: ${failedSql}
Database error: ${errorMessage}

Produce a corrected SELECT query following the same rules.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: healPrompt }] }],
    config: {
      systemInstruction: SQL_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: SQL_DECISION_SCHEMA,
      temperature: 0,
    },
  });
  return JSON.parse(response.text);
}

// Turns a question into a vector for the semantic cache (Phase 4). Same
// Gemini API key/billing as everything else here — no new provider needed.
export async function embedText(text) {
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [text],
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });
  return response.embeddings[0].values;
}

export async function summarize(question, rows) {
  const prompt = `You are a friendly storefront assistant. Given the visitor's question and the
database rows below (JSON), write a concise, natural-language answer. If the rows are empty, say
the store doesn't have anything matching. Do not mention SQL or tables. If a row represents a
product being recommended or referenced, include a link to it as /products/<slug> (using that
row's slug field) in the answer text. Never link to an image_url as if it were the product page.

Question: ${question}
Rows: ${JSON.stringify(rows)}`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { temperature: 0.3 },
  });
  return response.text.trim();
}
