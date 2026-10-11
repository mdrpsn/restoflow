import type { getDailyOperationsSummary } from "@/lib/dailySummary";

/**
 * A narrative layer over the daily operations summary, not a new source of truth.
 * Gemini only ever reads the already-computed numbers below and writes plain-English
 * prose about them — it never sees raw rows, never gets write access to anything, and
 * the real numbers stay on screen next to it so the narrative can be checked against
 * them rather than trusted blindly.
 */

const MODEL = "gemini-flash-latest";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export type DailyOperationsSummary = Awaited<ReturnType<typeof getDailyOperationsSummary>>;

export class AiSummaryError extends Error {}

function buildPrompt(summary: DailyOperationsSummary): string {
  return [
    "You are writing a short end-of-day operations note for a bubble tea and Korean street food restaurant manager.",
    "Below is one branch's real, already-computed numbers for one day, as JSON. Do not invent numbers not present here.",
    "Write 4-8 short sentences, plain English, no markdown headers: highlight what mattered (revenue, notable waste, low stock, unmapped-recipe revenue, any large variance), and flag anything that looks off. If nothing looks off, say so plainly instead of inventing a concern.",
    "",
    JSON.stringify(summary),
  ].join("\n");
}

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 503]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(apiKey: string, prompt: string): Promise<Response> {
  return fetch(`${API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // thinkingBudget: 0 disables Gemini 3's extended-thinking tokens, which otherwise
      // eat most of maxOutputTokens before any visible text is written (observed
      // responses cut off after 1-2 sentences) — this is plain narration, not a task
      // that benefits from extended reasoning.
      generationConfig: { temperature: 0.3, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } },
    }),
    // A stuck AI call should never hang the report page indefinitely.
    signal: AbortSignal.timeout(20_000),
  });
}

export async function generateDailySummaryNarrative(summary: DailyOperationsSummary): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiSummaryError("GEMINI_API_KEY is not set");

  const prompt = buildPrompt(summary);
  let lastError: string = "";

  // The free-tier model is genuinely flaky under load (observed 503 "high demand"
  // several times in a row) — a short retry is warranted, not a workaround for a bug.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await callGemini(apiKey, prompt);
    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
      if (!text) throw new AiSummaryError("Gemini returned no text (the response may have been blocked)");
      return text.trim();
    }
    const body = await res.text().catch(() => "");
    lastError = `Gemini API error ${res.status}: ${body.slice(0, 300)}`;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) break;
    await sleep(1000 * attempt);
  }
  throw new AiSummaryError(lastError);
}
