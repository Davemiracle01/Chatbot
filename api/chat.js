import { RECIPES } from "./_recipes.js";

const MAX_MESSAGE_LEN = 500;
const MAX_HISTORY_TURNS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 15; // requests per IP per window

// Best-effort in-memory limiter. Resets on cold start.
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

const LEVEL = { 1: "Easy", 2: "Medium", 3: "Hard" };
const short = (r) => r.name.replace(/\s*\(.*?\)/g, "").trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Find the recipe the visitor is asking about. Longest matching name wins,
// so "ugali na maziwa mala" beats plain "ugali".
function findRecipe(text) {
  const t = text.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const r of RECIPES) {
    for (const a of [short(r).toLowerCase(), ...r.aka]) {
      if (a.length > bestLen && new RegExp(`\\b${esc(a)}\\b`).test(t)) {
        best = r;
        bestLen = a.length;
      }
    }
  }
  return best;
}

const fullRecipe = (r) =>
  `${r.name} (${LEVEL[r.level]}, ${r.time}, serves ${r.serves})\nIngredients: ${r.ing.join("; ")}\nSteps: ${r.steps.map((s, i) => `${i + 1}. ${s}`).join(" ")}\nTip: ${r.tip}`;

const catalog = RECIPES.map((r) => `- ${short(r)} (${LEVEL[r.level]}, ${r.type}, ${r.time})`).join("\n");

function buildPersona(matched, context) {
  let p = `You are the kitchen assistant on Quick & Easy Recipes, an African home-cooking website with recipes from Kenya, Nigeria, Ghana, South Africa, Ethiopia, Uganda, Tanzania, Senegal and Morocco. You help with those recipes: rice, soups, sauces, toppings, swallow (ugali, eba, fufu, amala, pounded yam), barbecue and snacks. You know every recipe on the site (listed below) and can also answer general cooking questions, substitutions, timing and serving ideas.

Style: warm, practical and short. Reply in the same language the visitor writes in (English, Swahili or Sheng). Never invent steps that contradict the site's recipes.

Recipes on the site:
${catalog}
`;
  if (matched) {
    p += `\nThe visitor asked about this recipe. The website is showing them a recipe card with the photo, ingredients and steps, so do NOT repeat the ingredients or steps. Write 2 to 4 lively sentences (under 70 words): what the dish is, one tip or what to serve it with, and offer to answer questions.\n\n${fullRecipe(matched)}\n`;
  } else if (context) {
    p += `\nThe visitor is currently looking at this recipe, so questions like "can I use less oil" refer to it:\n\n${fullRecipe(context)}\n\nAnswer their question directly and briefly (under 100 words).\n`;
  } else {
    p += `\nNo specific recipe was matched. Answer briefly (under 100 words). If they want ideas, suggest 2 to 4 dishes from the list above BY EXACT NAME so they can tap them. If they ask for a dish that is not on the list, give a short helpful answer and say it is not on the site yet.\n`;
  }
  return p;
}

const publicRecipe = (r) => r.id;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({ reply: "Too many messages. Wait a minute and try again." });
  }

  const { message, history, context } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Missing message" });
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({ reply: `Keep your message under ${MAX_MESSAGE_LEN} characters.` });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: no GROQ_API_KEY" });
  }

  const matched = findRecipe(message);
  const ctxRecipe = !matched && typeof context === "string" ? RECIPES.find((r) => r.id === context) : null;

  const cleanHistory = Array.isArray(history)
    ? history
        .filter((m) => m && typeof m.content === "string")
        .slice(-MAX_HISTORY_TURNS)
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content.slice(0, MAX_MESSAGE_LEN),
        }))
    : [];

  const messages = [
    { role: "system", content: buildPersona(matched, ctxRecipe) },
    ...cleanHistory,
    { role: "user", content: message },
  ];

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        reasoning_effort: "low",
        messages,
      }),
    });

    if (groqRes.status === 429) {
      return res.status(429).json({ reply: "The kitchen is busy right now. Try again in a moment." });
    }
    if (!groqRes.ok) {
      console.error("Groq error:", await groqRes.text());
      return res.status(502).json({ error: "Groq request failed" });
    }

    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content || "Sorry, I could not get an answer. Try again.";

    // Recipes the AI mentioned by name become tap-to-open suggestions.
    const lower = reply.toLowerCase();
    const suggest = RECIPES.filter((r) => r.id !== matched?.id && new RegExp(`\\b${esc(short(r).toLowerCase())}\\b`).test(lower))
      .slice(0, 4)
      .map(publicRecipe);

    return res.status(200).json({ reply, recipe: matched ? matched.id : null, suggest });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}

