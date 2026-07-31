import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { answerQuestion } from "@/app/_lib/graph";
import { getSessionHistory, appendToSessionHistory } from "@/app/_lib/sessionMemory";

const SESSION_COOKIE = "chat_session_id";
// How long the browser remembers this ID — separate from how long the
// conversation *content* survives in Redis (sessionMemory.js's own TTL). A
// returning visitor within this window keeps the same ID, but if their last
// message was long enough ago that Redis already expired the history, they
// transparently start a fresh conversation under that same ID.
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function POST(request) {
  const body = await request.json();
  const { message } = body;

  if (!message || typeof message !== "string") {
    return Response.json({ error: "Missing 'message' string." }, { status: 400 });
  }

  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value || randomUUID();

  const history = await getSessionHistory(sessionId);
  const result = await answerQuestion(message, history);

  await appendToSessionHistory(sessionId, "user", message);
  await appendToSessionHistory(sessionId, "assistant", result.answer);

  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });

  return Response.json(result);
}
