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

// This deployment's own widget (page.js, served from this same app) always
// calls this same-origin — no Origin header restriction applies, and it
// works with zero configuration. Everything below only matters for a
// *different* site embedding this store's chatbot.
function isCrossOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin !== new URL(request.url).origin;
}

// Two checks, both required for a cross-origin caller: the origin has to be
// on the allowlist (this is what actually stops a browser from letting an
// unauthorized page's own JS read the response — a real browser can't spoof
// its own Origin header), and it has to send the site key (this alone can
// be copied out of a legitimate embed's source, same as a Stripe
// publishable key or Google Maps key — it's not a secret — but combined
// with the origin check, a would-be abuser now needs both the exact
// approved origin string *and* the key, not just one guessable header).
// Neither check stops a determined attacker calling the API directly with
// curl and both values in hand; that requires the stronger server-to-server
// proxy model, not this one — see ROADMAP.md for that tradeoff.
function isAllowedOrigin(request) {
  const origin = request.headers.get("origin");
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

// A CORS preflight (OPTIONS) never carries the real value of a custom
// header, only a *declaration* that the real request will include one
// (via Access-Control-Request-Headers) — so the site key can only be
// checked on the actual POST, never during preflight. isAllowedOrigin()
// alone is what gates OPTIONS; this stricter check gates POST.
function isAuthorizedCrossOrigin(request) {
  if (!isAllowedOrigin(request)) return false;
  const expectedKey = process.env.CHATBOT_SITE_KEY;
  const siteKey = request.headers.get("x-site-key");
  return Boolean(expectedKey) && siteKey === expectedKey;
}

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("origin"),
    "Access-Control-Allow-Credentials": "true",
    // Tells caches/CDNs the response varies by Origin, so one origin's
    // cross-origin allowance never gets served to a different origin.
    Vary: "Origin",
  };
}

// Browsers send this automatically before a cross-origin POST with a JSON
// body (it's not a "simple request") to ask permission first — no actual
// chat request is inside a preflight, just headers.
export async function OPTIONS(request) {
  if (!isCrossOrigin(request)) {
    return new Response(null, { status: 204 });
  }
  if (!isAllowedOrigin(request)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-site-key",
    },
  });
}

export async function POST(request) {
  const crossOrigin = isCrossOrigin(request);
  if (crossOrigin && !isAuthorizedCrossOrigin(request)) {
    return Response.json({ error: "This site isn't authorized to use this API." }, { status: 403 });
  }
  const extraHeaders = crossOrigin ? corsHeaders(request) : {};

  const body = await request.json();
  // Either a typed `message`, or `audio` (base64) + `audioMimeType` from a
  // voice recording — never both. `voice: true` additionally asks for the
  // answer to be spoken back, not just typed back.
  const { message, audio, audioMimeType, voice } = body;

  if ((!message || typeof message !== "string") && !audio) {
    return Response.json(
      { error: "Missing 'message' string or 'audio' recording." },
      { status: 400, headers: extraHeaders }
    );
  }

  // Cookies must be set before the streaming response begins — once the
  // first chunk goes out, headers (Set-Cookie included) can no longer
  // change. Reading/creating the session ID doesn't depend on anything the
  // graph produces, so this can safely happen up front.
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value || randomUUID();
  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    // A cross-origin fetch() only ever carries a SameSite=Lax cookie for
    // top-level navigations, not for API calls like this one — an embedded
    // widget would silently lose conversation memory without this. "None"
    // requires "Secure" (HTTPS-only) by spec; same-origin keeps the
    // stricter default since it doesn't need the exception.
    sameSite: crossOrigin ? "none" : "lax",
    secure: crossOrigin,
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
      ...extraHeaders,
    },
  });
}
