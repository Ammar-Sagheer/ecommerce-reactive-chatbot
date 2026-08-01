"use client";

import { useState } from "react";
import Chart from "./_components/Chart";

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

export default function Home() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hi! Ask me about products in the store." },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  function updateAssistantMessage(index, patch) {
    setMessages((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  async function sendMessage(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    // Placeholder assistant message, filled in live as stream events arrive.
    const assistantIndex = messages.length + 1;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "", progress: "Thinking…" },
    ]);
    setInput("");
    setLoading(true);

    let answerText = "";

    try {
      // No history sent here — the server keeps its own rolling window in
      // Redis, keyed by a session cookie the browser sends automatically.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`request failed (${res.status})`);
      }

      for await (const event of readServerSentEvents(res)) {
        if (event.type === "progress") {
          updateAssistantMessage(assistantIndex, { progress: event.message });
        } else if (event.type === "token") {
          answerText += event.text;
          updateAssistantMessage(assistantIndex, { content: answerText, progress: null });
        } else if (event.type === "done") {
          updateAssistantMessage(assistantIndex, { chart: event.chart, rows: event.rows });
        } else if (event.type === "error") {
          updateAssistantMessage(assistantIndex, { content: `Error: ${event.message}`, progress: null });
        }
      }
    } catch (err) {
      updateAssistantMessage(assistantIndex, { content: `Error: ${err.message}`, progress: null });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <div className="flex h-[32rem] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-xl">
        <div className="bg-zinc-900 px-4 py-3 text-white">
          <span className="font-semibold">ecommerce-reactive-chatbot — Phase 1</span>
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
