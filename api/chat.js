const MAX_MESSAGE_LEN = 500;
const MAX_HISTORY_TURNS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 15; // requests per IP per window

// Best-effort in-memory limiter. Resets on cold start — fine for casual
// abuse deterrence, not a hard guarantee. For a real guarantee, swap this
// for Upstash/Vercel KV.
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({ reply: "Naomba subiri kidogo kisha jaribu tena." });
  }

  const { message, history } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Missing message" });
  }

  if (message.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({ reply: `Fupisha ujumbe chini ya herufi ${MAX_MESSAGE_LEN}.` });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: no GROQ_API_KEY" });
  }

  // Generic assistant persona for Subra's portfolio — not a character.
  const persona = `You are the helpful AI assistant on Subra's website. Subra is a designer and artist based in Tanzania, working in digital art, branding, and UI concepts. Answer questions about Subra's work and how to get in touch, and general questions too. Be friendly, concise, and helpful. Keep replies under 40 words. Respond in the same language the visitor writes in (Swahili or English).`;

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
    { role: "system", content: persona },
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
        messages,
      }),
    });

    if (groqRes.status === 429) {
      return res.status(429).json({ reply: "Maombi mengi kwa sasa — jaribu tena baadaye kidogo." });
    }

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq error:", errText);
      return res.status(502).json({ error: "Groq request failed" });
    }

    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content || "Samahani, sijapata jibu kwa sasa.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
