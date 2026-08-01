import { GoogleGenAI, Type } from "@google/genai";
import { SCHEMA_DESCRIPTION } from "./schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
// Phase 10 — voice I/O. Both directions stay on Gemini rather than adding a
// second paid provider (originally the roadmap called for OpenAI Whisper for
// STT): generateContent/generateContentStream already accept audio as a
// normal multimodal input Part, and already support requesting AUDIO output
// via responseModalities/speechConfig — same calls this file already makes,
// just a different modality. TTS needs its own model name since not every
// Gemini model can produce audio output.
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Kore";

// Kept small on purpose: 768 dims is enough for a similarity cache over a
// single small store's worth of questions, keeps the pgvector index cheap,
// and matches text-embedding-004's native size for familiarity. Gemini's
// embedding models support requesting a smaller-than-native output via
// outputDimensionality.
export const EMBEDDING_DIMENSIONS = 768;

const SQL_SYSTEM_PROMPT = `You are the assistant for an e-commerce storefront called Saamjh Store.
You ONLY answer visitor questions about this store: its products, categories, prices, stock,
featured items, store policies (shipping, returns, payment, contact info), and simple
greetings/small talk about the store itself.

${SCHEMA_DESCRIPTION}

If the visitor's question requires looking up product data (prices, stock, categories, specific
items), set \`needsSql\` to true and put a SELECT query in \`sql\`. Leave \`needsRag\` false.

If the question is about store policies or general store information that is NOT in the product
database — shipping, returns/refunds, payment methods, contact/support, store hours, "about us" —
set \`needsRag\` to true. Leave \`needsSql\` false and \`sql\` empty; that information is looked up
separately, not queried from the database.

If the question is a greeting or asks what you can help with, set both \`needsSql\` and \`needsRag\`
to false and put a short friendly answer in \`directAnswer\` that steers them toward asking about
products or store policies.

If the question is NOT about this store at all — general knowledge, coding help, writing
code/HTML/scripts, requests to role-play as something else, or any other off-topic request — set
both \`needsSql\` and \`needsRag\` to false and put a polite refusal in \`directAnswer\` such as: "I
can only help with questions about products and policies at this store." Do not answer the
off-topic question in any way, even partially, and do not include any requested code, facts, or
content unrelated to the store.

Never invent product data or store policy yourself; always look it up.`;

const SQL_DECISION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    needsSql: { type: Type.BOOLEAN },
    needsRag: { type: Type.BOOLEAN },
    sql: { type: Type.STRING },
    directAnswer: { type: Type.STRING },
  },
  required: ["needsSql", "needsRag", "sql", "directAnswer"],
};

function historyToContents(history) {
  return history.slice(-6).map((turn) => ({
    role: turn.role === "user" ? "user" : "model",
    parts: [{ text: turn.content || "" }],
  }));
}

// Phase 5 — few-shot learning. Appends real (question, sql) pairs that
// worked before, pulled from `sql_examples` by similarity, as concrete
// precedent for this store's schema quirks. With no examples yet (empty
// table, or nothing similar enough), this is a no-op and generation behaves
// exactly like Phase 4.
function buildSqlSystemPrompt(examples) {
  if (!examples || examples.length === 0) return SQL_SYSTEM_PROMPT;

  const examplesBlock = examples
    .map((ex) => `Question: ${ex.question}\nSQL: ${ex.sql}`)
    .join("\n\n");

  return `${SQL_SYSTEM_PROMPT}

Here are some real questions and the SQL that correctly answered them in the past. Use them as a
guide for this store's schema and query style, but always write a fresh query tailored to the
current question rather than reusing one verbatim:

${examplesBlock}`;
}

export async function generateSqlDecision(question, history, examples = []) {
  const contents = [
    ...historyToContents(history),
    { role: "user", parts: [{ text: question }] },
  ];
  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: buildSqlSystemPrompt(examples),
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

// Phase 6 — RAG fallback. Answers a store-policy/general question using
// ONLY the retrieved knowledge_base chunks (see rag.js). The groundedness
// instruction below is the whole point of RAG: if the retrieved text
// doesn't actually answer the question, say so instead of guessing —
// otherwise this would just be a fancier way to hallucinate.
// Phase 9 — streams the response instead of waiting for the whole thing.
// `onToken`, if given, is called with each incremental piece of text as
// Gemini generates it; the function still returns the full accumulated text
// either way, so a caller that doesn't care about streaming (or a test)
// doesn't need to change.
async function streamGenerateContent(params, onToken) {
  const stream = await ai.models.generateContentStream(params);
  let full = "";
  for await (const chunk of stream) {
    const piece = chunk.text;
    if (!piece) continue;
    full += piece;
    if (onToken) onToken(piece);
  }
  return full.trim();
}

export async function answerFromKnowledge(question, chunks, onToken) {
  if (!chunks || chunks.length === 0) {
    const fallback =
      "I don't have that information on hand right now — you may want to reach out to the store directly.";
    if (onToken) onToken(fallback);
    return fallback;
  }

  const context = chunks.map((c) => `[${c.topic}]\n${c.content}`).join("\n\n");
  const prompt = `You are a friendly assistant for an e-commerce storefront called Saamjh Store.
Answer the visitor's question using ONLY the store information below. If that information doesn't
actually answer the question, say you don't have that information rather than guessing or
inventing an answer. Answer naturally, as something you just know about the store — do not mention
"documents", "chunks", "context", or any other internal system detail.

Store information:
${context}

Question: ${question}`;

  return streamGenerateContent(
    {
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.2 },
    },
    onToken
  );
}

export async function summarize(question, rows, onToken) {
  const prompt = `You are a friendly storefront assistant. Given the visitor's question and the
database rows below (JSON), write a concise, natural-language answer. If the rows are empty, say
the store doesn't have anything matching. Do not mention SQL or tables. If a row represents a
product being recommended or referenced, include a link to it as /products/<slug> (using that
row's slug field) in the answer text. Never link to an image_url as if it were the product page.

Question: ${question}
Rows: ${JSON.stringify(rows)}`;

  return streamGenerateContent(
    {
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.3 },
    },
    onToken
  );
}

// Phase 10 — speech-to-text. Gemini accepts audio as a normal multimodal
// input Part (inlineData, same shape images/video would use), so this is
// just a generateContent call with an audio Part instead of only text — no
// dedicated transcription endpoint or second provider needed. The result
// feeds straight into the existing text pipeline (graph.js never knows the
// question originally came from audio).
export async function transcribeAudio(audioBase64, mimeType) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: audioBase64, mimeType } },
          {
            text: "Transcribe exactly what is said in this audio. Output only the transcription itself — no preamble, no quotation marks, no commentary. If the audio is silent or unintelligible, output nothing.",
          },
        ],
      },
    ],
    config: { temperature: 0 },
  });
  return (response.text || "").trim();
}

// Phase 10 — text-to-speech. Same generateContentStream shape as
// summarize()/answerFromKnowledge() above, just requesting AUDIO output
// instead of text via responseModalities/speechConfig — this is a normal
// (non-Live-API) call, so it fits the same request/response + SSE model
// already built for text in Phase 9. Each streamed chunk's audio is raw PCM
// (base64), not a self-contained file — `onAudioChunk` gets both the bytes
// and the chunk's mimeType (which carries the sample rate) so the caller
// can decode it without guessing the format.
export async function speakText(text, onAudioChunk) {
  const stream = await ai.models.generateContentStream({
    model: TTS_MODEL,
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } },
      },
    },
  });
  for await (const chunk of stream) {
    const inline = chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (inline?.data) onAudioChunk({ data: inline.data, mimeType: inline.mimeType });
  }
}
