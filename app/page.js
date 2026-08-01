"use client";

import { useRef, useState } from "react";
import Chart from "./_components/Chart";

const STORE_NAME = process.env.NEXT_PUBLIC_STORE_NAME || "Saamjh Store";

// Phase 9 — parses a text/event-stream response by hand. The browser's
// built-in EventSource only supports GET requests with no body, and this
// needs to POST the question — so this reads the raw stream with fetch()
// and splits it into SSE frames itself instead.
async function* readServerSentEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) yield JSON.parse(dataLine.slice("data: ".length));
    }
  }
}

// Phase 10 — a recorded audio Blob needs to travel to the server as JSON
// (same body shape as a typed message), so it gets base64-encoded first.
// readAsDataURL produces "data:<mime>;base64,<payload>" — only the part
// after the comma is the actual base64 data.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export default function Home() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: `Hi! Ask me about products at ${STORE_NAME}.` },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioCtxRef = useRef(null);
  // Tracks the end time of the last scheduled audio chunk, so each new
  // chunk gets queued right after the previous one instead of overlapping
  // it or waiting for it to actually finish playing before being scheduled.
  const nextPlayTimeRef = useRef(0);

  function updateMessage(index, patch) {
    setMessages((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  // Phase 10 — plays one streamed TTS chunk. Gemini's audio output is raw
  // PCM (16-bit signed, little-endian), not a self-contained file — there's
  // no format an <audio> tag could just point at, so this decodes the
  // samples by hand into a Web Audio AudioBuffer and schedules it to start
  // exactly when the previous chunk ends, giving gapless playback across
  // chunks that arrived as separate network events.
  // Browsers only let an AudioContext actually produce sound if it was
  // created (or resumed) synchronously inside a real user gesture — a click
  // handler, not something several `await`s deep inside an async stream.
  // Call this directly from an onClick/onSubmit, before any await, so
  // there's an unbroken chain back to the click. Playback later, deep
  // inside the SSE loop, just reuses the already-running context.
  function unlockAudioContext() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      nextPlayTimeRef.current = 0;
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
  }

  function playPcmChunk(base64, mimeType) {
    // Should already exist and be running by now (unlockAudioContext ran
    // synchronously in the click handler that kicked off this request) —
    // this is only a fallback in case that path was somehow skipped.
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      nextPlayTimeRef.current = 0;
    }
    const ctx = audioCtxRef.current;

    const rateMatch = /rate=(\d+)/.exec(mimeType || "");
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));

    const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + audioBuffer.duration;
  }

  // Shared by both typed and spoken questions — everything past "here's the
  // request body" is identical, since the server answers both the same way.
  async function sendToServer(requestBody, userIndex, assistantIndex) {
    setLoading(true);
    let answerText = "";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok || !res.body) {
        throw new Error(`request failed (${res.status})`);
      }

      for await (const event of readServerSentEvents(res)) {
        if (event.type === "transcript") {
          // Only sent for voice input — fills in the user bubble that was
          // shown as a placeholder while the recording was being sent.
          updateMessage(userIndex, { content: event.text });
        } else if (event.type === "progress") {
          updateMessage(assistantIndex, { progress: event.message });
        } else if (event.type === "token") {
          answerText += event.text;
          updateMessage(assistantIndex, { content: answerText, progress: null });
        } else if (event.type === "done") {
          updateMessage(assistantIndex, { chart: event.chart, rows: event.rows });
        } else if (event.type === "audio") {
          playPcmChunk(event.data, event.mimeType);
        } else if (event.type === "error") {
          updateMessage(assistantIndex, { content: `Error: ${event.message}`, progress: null });
        }
      }
    } catch (err) {
      updateMessage(assistantIndex, { content: `Error: ${err.message}`, progress: null });
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;
    if (voiceEnabled) unlockAudioContext();

    const userIndex = messages.length;
    const assistantIndex = messages.length + 1;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "", progress: "Thinking…" },
    ]);
    setInput("");

    await sendToServer({ message: question, voice: voiceEnabled }, userIndex, assistantIndex);
  }

  // Phase 10 — voice input. MediaRecorder captures whatever codec the
  // browser defaults to (commonly audio/webm;codecs=opus in Chrome); the
  // real mimeType it reports is sent along with the recording so the server
  // can pass it through to Gemini accurately instead of guessing.
  async function startRecording() {
    if (voiceEnabled) unlockAudioContext();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const base64 = await blobToBase64(blob);

        const userIndex = messages.length;
        const assistantIndex = messages.length + 1;
        setMessages((prev) => [
          ...prev,
          { role: "user", content: "🎤 …" },
          { role: "assistant", content: "", progress: "Thinking…" },
        ]);

        await sendToServer(
          { audio: base64, audioMimeType: blob.type, voice: voiceEnabled },
          userIndex,
          assistantIndex
        );
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Couldn't access the microphone: ${err.message}` }]);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <div className="flex h-[32rem] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-xl">
        <div className="flex items-center justify-between bg-zinc-900 px-4 py-3 text-white">
          <span className="font-semibold">{STORE_NAME}</span>
          <button
            type="button"
            onClick={() => {
              unlockAudioContext();
              setVoiceEnabled((v) => !v);
            }}
            title={voiceEnabled ? "Voice replies on" : "Voice replies off"}
            className={`rounded-full px-2 py-1 text-xs ${voiceEnabled ? "bg-white text-zinc-900" : "bg-zinc-700 text-zinc-300"}`}
          >
            {voiceEnabled ? "🔊" : "🔈"}
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                m.role === "user" ? "ml-auto bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-800"
              }`}
            >
              {m.content || (
                <span className="text-zinc-500">{m.progress}</span>
              )}
              <Chart chart={m.chart} rows={m.rows} />
            </div>
          ))}
        </div>
        <form onSubmit={sendMessage} className="flex gap-2 border-t border-black/10 p-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about a product…"
            disabled={loading}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
          <button
            type="button"
            onClick={recording ? stopRecording : startRecording}
            disabled={loading}
            title={recording ? "Stop recording" : "Ask by voice"}
            className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${
              recording ? "bg-red-600 text-white" : "bg-zinc-200 text-zinc-900"
            }`}
          >
            {recording ? "⏹" : "🎤"}
          </button>
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
