import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { streamAnswer } from "@/app/_lib/graph";
import { transcribeAudio, speakText } from "@/app/_lib/agent";
import { getSessionHistory, appendToSessionHistory } from "@/app/_lib/sessionMemory";

const SESSION_COOKIE = "chat_session_id";
// How long the browser remembers this ID — separate from how long the
// conversation *content* survives in Redis (sessionMemory.js's own TTL). A
// returning visitor within this window keeps the same ID, but if their last
// message was long enough ago that Redis already expired the history, they
// transparently start a fresh conversation under that same ID.
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request) {
  const body = await request.json();
  // Either a typed `message`, or `audio` (base64) + `audioMimeType` from a
  // voice recording — never both. `voice: true` additionally asks for the
  // answer to be spoken back, not just typed back.
  const { message, audio, audioMimeType, voice } = body;

  if ((!message || typeof message !== "string") && !audio) {
    return Response.json({ error: "Missing 'message' string or 'audio' recording." }, { status: 400 });
  }

  // Cookies must be set before the streaming response begins — once the
  // first chunk goes out, headers (Set-Cookie included) can no longer
  // change. Reading/creating the session ID doesn't depend on anything the
  // graph produces, so this can safely happen up front.
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value || randomUUID();
  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let question = message;

        if (audio) {
          question = await transcribeAudio(audio, audioMimeType || "audio/webm");
          // The client never typed this — it needs the recognized text to
          // show as the user's own message bubble before anything else.
          controller.enqueue(encoder.encode(sseEvent({ type: "transcript", text: question })));
          if (!question) {
            throw new Error("Couldn't make out anything in that recording.");
          }
        }

        const history = await getSessionHistory(sessionId);

        const result = await streamAnswer(question, history, (event) => {
          controller.enqueue(encoder.encode(sseEvent(event)));
        });

        await appendToSessionHistory(sessionId, "user", question);
        await appendToSessionHistory(sessionId, "assistant", result.answer);

        // The answer text itself already streamed as "token" events above —
        // this carries just the extra structured fields that were never
        // part of the text stream (a chart spec, the raw rows, the SQL
        // used), plus a signal that there's nothing more coming.
        controller.enqueue(
          encoder.encode(
            sseEvent({ type: "done", chart: result.chart, rows: result.rows, sqlUsed: result.sqlUsed })
          )
        );

        if (voice) {
          await speakText(result.answer, (chunk) => {
            controller.enqueue(encoder.encode(sseEvent({ type: "audio", ...chunk })));
          });
          controller.enqueue(encoder.encode(sseEvent({ type: "audio_done" })));
        }
      } catch (err) {
        console.error("Streaming chat request failed:", err);
        controller.enqueue(
          encoder.encode(sseEvent({ type: "error", message: "Sorry, something went wrong." }))
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and similar reverse proxies buffer responses by default,
      // which would defeat streaming entirely if this ever sits behind one.
      "X-Accel-Buffering": "no",
    },
  });
}
