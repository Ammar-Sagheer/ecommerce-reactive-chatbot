"use client";

import { useState } from "react";
import Chart from "./_components/Chart";

export default function Home() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hi! Ask me about products in the store." },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendMessage(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    const nextMessages = [...messages, { role: "user", content: question }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      // No history sent here — the server keeps its own rolling window in
      // Redis, keyed by a session cookie the browser sends automatically.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
      });
      const data = await res.json();
      const answer = res.ok ? data.answer : `Error: ${data.error || "request failed"}`;
      setMessages([
        ...nextMessages,
        { role: "assistant", content: answer, chart: data.chart, rows: data.rows },
      ]);
    } catch (err) {
      setMessages([...nextMessages, { role: "assistant", content: `Error: ${err.message}` }]);
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
              {m.content}
              <Chart chart={m.chart} rows={m.rows} />
            </div>
          ))}
          {loading && (
            <div className="max-w-[85%] rounded-xl bg-zinc-100 px-3 py-2 text-sm text-zinc-500">
              Thinking…
            </div>
          )}
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
