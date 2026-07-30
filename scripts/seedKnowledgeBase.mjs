import { GoogleGenAI } from "@google/genai";
import { Pool } from "pg";

// Phase 6 — one-time seed script for the RAG knowledge base. Standalone
// (doesn't import from app/_lib) so it can run directly with plain `node`
// without hitting Next.js's build pipeline or CommonJS/ESM module
// resolution issues.
//
// Run locally (never in this build container — it needs the Postgres
// pooler on port 6543, which this container can't reach):
//   node --env-file=.env.local scripts/seedKnowledgeBase.mjs
//
// PLACEHOLDER CONTENT: everything in PLACEHOLDER_CHUNKS below is clearly
// fictional demo text, written to prove the RAG mechanism works — not real
// store policy. It MUST be replaced with real shipping/returns/payment/
// contact content before this app is ever pointed at real customer traffic.
// (Ammar: this is your reminder — ask before wiring this chatbot into the
// real store UI if this note is still here.)

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;

const PLACEHOLDER_CHUNKS = [
  {
    topic: "shipping",
    content:
      "Saamjh Store currently ships within the country only. Standard delivery takes 3-7 " +
      "business days from when an order is placed. Shipping cost is calculated at checkout " +
      "based on order size and destination.",
  },
  {
    topic: "returns",
    content:
      "Items can be returned within 14 days of delivery for a full refund, as long as they are " +
      "unused, unworn, and in their original packaging. To start a return, contact support with " +
      "your order number.",
  },
  {
    topic: "payment",
    content:
      "Saamjh Store accepts major credit and debit cards at checkout. Payment is charged when " +
      "the order is placed, not when it ships.",
  },
  {
    topic: "contact",
    content:
      "For questions about an order, a product, or anything else, reach out through the contact " +
      "form on the website. Support typically responds within 1-2 business days.",
  },
  {
    topic: "about",
    content:
      "Saamjh Store is an online storefront offering a curated selection of products across " +
      "several categories. It's a small, independently run store focused on quality over " +
      "quantity.",
  },
];

function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // chatbot_readonly is deliberately SELECT/INSERT-only on this table (no
    // DELETE/UPDATE — knowledge_base isn't meant to be mutable at request
    // time), so this script can't clear-and-reinsert on its own. Guard
    // against accidental duplicate rows instead: bail out if it looks like
    // seeding already happened, and point at the manual fix.
    const { rows: existing } = await pool.query("select count(*)::int as count from knowledge_base");
    if (existing[0].count > 0) {
      console.log(
        `knowledge_base already has ${existing[0].count} row(s). Re-running this script would ` +
        `create duplicates since it can only INSERT, not DELETE. If you want to reseed (e.g. after ` +
        `editing PLACEHOLDER_CHUNKS), clear the table first via the Supabase SQL editor ` +
        `("delete from knowledge_base;", using your admin/postgres connection, not chatbot_readonly), ` +
        `then run this script again.`
      );
      return;
    }

    for (const chunk of PLACEHOLDER_CHUNKS) {
      const response = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: [chunk.content],
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });
      const vectorLiteral = toVectorLiteral(response.embeddings[0].values);

      await pool.query(
        "insert into knowledge_base (topic, content, embedding) values ($1, $2, $3::vector)",
        [chunk.topic, chunk.content, vectorLiteral]
      );
      console.log(`Seeded: ${chunk.topic}`);
    }

    console.log(`Done — seeded ${PLACEHOLDER_CHUNKS.length} knowledge_base chunk(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
