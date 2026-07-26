import { answerQuestion } from "@/app/_lib/agent";

export async function POST(request) {
  const body = await request.json();
  const { message, history = [] } = body;

  if (!message || typeof message !== "string") {
    return Response.json({ error: "Missing 'message' string." }, { status: 400 });
  }

  const result = await answerQuestion(message, history);
  return Response.json(result);
}
