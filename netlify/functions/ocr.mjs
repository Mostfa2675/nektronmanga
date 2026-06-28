// Nektron Manga — OCR via Google Gemini
export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 500 });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const { image, lang = "ara" } = body;
  if (!image || !image.startsWith("data:image")) {
    return new Response(JSON.stringify({ error: "Invalid image" }), { status: 400 });
  }

  const langHint = lang === "ara" ? "Arabic" : lang === "jpn" ? "Japanese" : lang === "eng" ? "English" : lang;
  const reading = lang === "jpn" ? "Right-to-left manga style" : lang === "ara" ? "Right-to-left" : "Left-to-right";

  const base64 = image.split(",")[1];
  const mimeType = image.split(";")[0].split(":")[1] || "image/jpeg";

  const prompt = `You are an expert OCR engine for manga, manhwa, and manhua pages.

LANGUAGE: ${langHint}
READING ORDER: ${reading}

RULES:
1. Extract ALL text: speech bubbles, thought bubbles, narration boxes, sound effects, signs.
2. Label each block:
   [BUBBLE] = dialogue
   [THOUGHT] = inner monologue
   [NARRATION] = narrator box
   [SFX] = sound effects
   [SIGN] = background text/signs
3. Follow strict reading order of the page.
4. Separate each block with a blank line.
5. Do NOT describe images or characters — text only.
6. Do NOT translate or add commentary.
7. Keep original text exactly as written.
8. If page has no text, return exactly: [NO_TEXT]`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64 } }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        })
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Gemini error: ${res.status}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[NO_TEXT]";

    return new Response(JSON.stringify({ text: text.trim() }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "OCR failed" }), { status: 500 });
  }
};

export const config = { path: "/api/ocr" };
