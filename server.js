// server.js (CommonJS) - Ollama (Qwen) + Stable Diffusion WebUI (A1111) - Pro pipeline

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ================== CONFIG ==================
const OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/chat";
const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";
const MODEL = "qwen2.5:7b-instruct";

const SD_BASE_URL = "http://127.0.0.1:7860";
const SD_TXT2IMG_URL = `${SD_BASE_URL}/sdapi/v1/txt2img`;
const SD_MODELS_URL = `${SD_BASE_URL}/sdapi/v1/sd-models`;


const OLLAMA_TIMEOUT_MS = 10 * 60 * 1000; // 10 دقائق



const SD_DEFAULTS = {
  steps: 28,
  cfg_scale: 6.5,
  width: 512,
  height: 512,
  sampler_name: "DPM++ 2M Karras",
};

// ================== UTILS ==================
function normalizeOneLine(s) {
  return String(s || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeJsonParseMaybe(str) {
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    const m = str.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function allowedHashtagByLang(tag, lang) {
  const t = normalizeOneLine(tag).replace(/\s+/g, "_");
  if (!t.startsWith("#")) return false;
  if (lang === "ar") return /^#[ء-ي0-9_]+$/.test(t);
  if (lang === "en") return /^#[A-Za-z0-9_]+$/.test(t);
  return /^#[ء-يA-Za-z0-9_]+$/.test(t);
}

function mapLang(lang) {
  if (lang === "en") return { label: "English", strict: "English only" };
  if (lang === "mix") return { label: "Arabic + English", strict: "Arabic and English only" };
  return { label: "Arabic", strict: "Arabic only" };
}

function splitTopics(raw) {
  return String(raw || "")
    .split(/[\n,،]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 80);
}

function defaultTopicsByLang(lang) {
  if (lang === "en")
    return [
      "study",
      "love",
      "technology",
      "health",
      "sports",
      "travel",
      "self-improvement",
      "music",
      "food",
      "movies",
      "friendship",
      "career",
      "productivity",
      "books",
      "gaming",
      "motivation",
    ];
  return [
    "الدراسة",
    "الحب",
    "التقنية",
    "الصحة",
    "الرياضة",
    "السفر",
    "تطوير الذات",
    "الموسيقى",
    "الطعام",
    "الأفلام",
    "الصداقة",
    "الوظيفة",
    "الإنتاجية",
    "الكتب",
    "الألعاب",
    "التحفيز",
  ];
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function scoreWeakText(text) {
  const t = String(text || "").toLowerCase();
  let score = 0;
  // indicators of "AI-ish / weak"
  if (t.length < 20) score += 2;
  if (t.length > 180) score += 2;
  if ((t.match(/\b(very|really|just|nice|cool|amazing|super)\b/g) || []).length >= 2) score += 2;
  if ((t.match(/\b(i am|i'm)\b/g) || []).length >= 3) score += 1;
  if ((t.match(/!!+/g) || []).length >= 1) score += 1;
  return score; // higher = weaker
}

function cleanPosts(rawPosts, { lang, ensureQuestionMark }) {
  const arr = Array.isArray(rawPosts) ? rawPosts : [];
  const fallbackTags =
    lang === "en"
      ? ["#community", "#discussion", "#social"]
      : lang === "mix"
      ? ["#تفاعل", "#community", "#نقاش"]
      : ["#تفاعل", "#مجتمع", "#نقاش"];

  const cleaned = arr.map((p, i) => {
    const id = Number(p?.id) || i + 1;

    let text = String(p?.text ?? "");
    text = normalizeOneLine(text);

    if (ensureQuestionMark) {
      const qm = lang === "en" ? "?" : "؟";
      if (!text.endsWith(qm)) {
        text = text.replace(/[!.。！？?؟]+$/g, "").trim() + qm;
      }
    }

    const type = typeof p?.type === "string" ? normalizeOneLine(p.type) : "post";

    let hashtags = Array.isArray(p?.hashtags) ? p.hashtags : [];
    hashtags = hashtags
      .map((h) => normalizeOneLine(h).replace(/\s+/g, "_"))
      .filter((h) => allowedHashtagByLang(h, lang));

    while (hashtags.length < 3) hashtags.push(fallbackTags[hashtags.length] || fallbackTags[0]);
    hashtags = hashtags.slice(0, 3);

    const topic = normalizeOneLine(p?.topic || "");

    const imagePrompt = normalizeOneLine(p?.imagePrompt || "");
    const negativePrompt = normalizeOneLine(
      p?.negativePrompt ||
        "text, watermark, logo, signature, blurry, low quality, worst quality, jpeg artifacts, deformed, bad anatomy, extra fingers"
    );

    return { id, topic, text, type, hashtags, imagePrompt, negativePrompt };
  });

  // remove duplicates by text
  return uniqBy(cleaned, (x) => x.text.toLowerCase());
}

// ================== PROMPT ENGINE ==================
function modelOptionsByKind(postKind) {
  const map = {
    funny: { temperature: 0.5, top_p: 0.85, num_predict: 1800 },
    tips: { temperature: 0.45, top_p: 0.85, num_predict: 2000 },
    discussion: { temperature: 0.55, top_p: 0.85, num_predict: 2200 },
    article: { temperature: 0.55, top_p: 0.9, num_predict: 2600 },
    quotes: { temperature: 0.5, top_p: 0.85, num_predict: 1400 },
    poetry: { temperature: 0.65, top_p: 0.9, num_predict: 2200 },
    politics: { temperature: 0.5, top_p: 0.85, num_predict: 2200 },
    question: { temperature: 0.5, top_p: 0.85, num_predict: 1800 },
  };
  return map[postKind] || { temperature: 0.6, top_p: 0.85, num_predict: 2000 };
}

function buildSystemRules(lang) {
  const L = mapLang(lang);
  return [
    "Return ONLY valid JSON. No extra text.",
    `Language policy: ${L.strict}.`,
    "Write in the selected language ONLY. Do not mix languages.",
    "Do not output any Cyrillic/Russian characters.",
    "Do not include Chinese/Korean/Thai characters.",
    "Hashtags must match the selected language policy.",
    "Image prompt must be suitable for Stable Diffusion and MUST NOT include any text overlays.",
    'Follow this exact JSON schema: { "posts": [ ... ] }',
  ].join(" ");
}

function buildKindInstruction(postKind) {
  const kindMap = {
    question: "Ask engaging questions that encourage replies. Make the question natural, specific, and easy to answer.",
    article: "Write a short micro-article with a clear point and a strong final hook line.",
    quotes: "Write short reflective phrases suitable for social media (not clichés).",
    poetry: "Write modern free verse lines with clear imagery and emotional coherence (avoid clichés).",
    funny: "Write clever, modern humor. Avoid cringe. End with a natural punchline.",
    politics: "Discuss politics neutrally and respectfully; avoid hate or incitement.",
    tips: "Give practical tips. End with a light hook (not necessarily a question).",
    discussion: "Start a discussion with a balanced opinion and invite others to share their view.",
  };
  return kindMap[postKind] || kindMap.discussion;
}

function buildUserPrompt({
  count,
  category,
  postKind,
  lang,
  lines,
  tone,
  allowEmojis,
  examples,
  description,
  randomTopics,
  randomTopicsCount,
  topicsPoolRaw,
}) {
  const kindInstruction = buildKindInstruction(postKind);

  const lineRule =
    lines <= 1
      ? "Each post must be a single line."
      : `Each post must be exactly ${lines} lines. Use '\\n' to separate lines inside the text value.`;

  // IMPORTANT: لا تجبره على ايموجي دائمًا (هذا يضعف الجودة). خليها 0-2.
  const emojiRule = allowEmojis ? "You may use 0-2 emojis per post." : "Do NOT use emojis.";
  const toneRule = tone ? `Tone: ${tone}.` : "Tone: natural and friendly.";

  const examplesBlock = examples ? `Examples (match style/mood, do not copy):\n${examples}\n` : "";
  const descriptionBlock = description ? `Topic description & constraints:\n${description}\n` : "";

  const pool = splitTopics(topicsPoolRaw);
  const basePool = pool.length ? pool : defaultTopicsByLang(lang);
  const n = Math.min(Number(randomTopicsCount || count), 50);

  const randomTopicsBlock = randomTopics
    ? `
Random topics mode:
- Assign a different topic for each post.
- Choose ${Math.min(count, n)} topics from this pool (avoid duplicates if possible):
${basePool.map((t) => `- ${t}`).join("\n")}
- Include the chosen topic in a field named "topic" for each post.
- Each post must clearly match its topic.
`
    : `
Single topic mode:
- All posts must match this category/topic: ${category}
- Set "topic" to "${category}" for each post.
`;

  // Schema now includes topic
  return `
Generate ${count} social posts for a new social app to seed engagement.
Post kind: ${postKind}
Language: ${lang}

${descriptionBlock}${examplesBlock}${randomTopicsBlock}

Rules:
- ${kindInstruction}
- ${toneRule}
- ${lineRule}
- ${emojiRule}
- Avoid exaggerated marketing language.
- Avoid generic AI phrases and clichés.
- Make each post feel human-written and specific.
- Provide exactly 3 hashtags per post (language-compliant).
- Add a numeric id from 1 to ${count}.
- Also generate an image prompt that matches the post closely.
- imagePrompt MUST be: (subject + scene + mood + lighting + style). Be visual. No abstract words.
- Do NOT include text, letters, logos, watermarks.

Output JSON ONLY (exact shape):
{
  "posts": [
    {
      "id": 1,
      "topic": "topic",
      "text": "line1\\nline2",
      "type": "${postKind}",
      "hashtags": ["#...","#...","#..."],
      "imagePrompt": "subject, scene, mood, lighting, style, high detail, no text",
      "negativePrompt": "text, watermark, logo, signature, blurry, low quality"
    }
  ]
}
`.trim();
}


async function ollamaChat({ messages, options }) {
  const payload = {
    model: MODEL,
    stream: false,
    format: "json",
    messages,
    options,
  };

  const maxRetries = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    try {
      const r = await fetch(OLLAMA_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      const t = await r.text();
      if (!r.ok) throw new Error(`Ollama error ${r.status}: ${t.slice(0, 300)}`);

      const data = safeJsonParseMaybe(t) || {};
      let content = data?.message?.content;
      if (typeof content === "string") content = safeJsonParseMaybe(content);
      return content;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === maxRetries) break;
      await new Promise((res) => setTimeout(res, 800 * attempt));
    }
  }

  throw lastErr;
}



// ---------- 3-STAGE GENERATION ----------
async function generatePostsPro(params) {
  const { postKind, lang, count } = params;

  const systemRules = buildSystemRules(lang);
  const userRules = buildUserPrompt(params);
  const modelOpt = modelOptionsByKind(postKind);

  // Stage A: Plan (internal)
  const planPrompt = `
Create a silent plan (still in JSON) for ${count} posts.
For each post decide:
- topic (respect random topics rules)
- angle
- emotion
- a strong ending punchline/hook (if relevant)
Return ONLY JSON with shape:
{ "plan": [ { "id":1, "topic":"...", "angle":"...", "emotion":"...", "ending":"..." } ] }
Do NOT write the final posts text here.
`.trim();

  const plan = await ollamaChat({
    messages: [
      { role: "system", content: systemRules },
      { role: "user", content: userRules },
      { role: "user", content: planPrompt },
    ],
    options: { ...modelOpt, num_predict: 1600 },
  });

  // Stage B: Write final posts based on plan
  const writePrompt = `
Using the plan below, write the FINAL posts.
Return ONLY JSON in the required output schema.
Plan JSON:
${JSON.stringify(plan || {}, null, 2)}
`.trim();

  const draft = await ollamaChat({
    messages: [
      { role: "system", content: systemRules },
      { role: "user", content: userRules },
      { role: "user", content: writePrompt },
    ],
    options: { ...modelOpt, num_predict: modelOpt.num_predict },
  });

  // Stage C: Critique & rewrite weak ones only
  const critiquePrompt = `
Review the generated posts.
Rewrite ONLY posts that feel generic, repetitive, too long, or weak.
Keep good posts unchanged.
Return ONLY JSON with the same output schema (posts array).
Generated JSON:
${JSON.stringify(draft || {}, null, 2)}
`.trim();

  const refined = await ollamaChat({
    messages: [
      { role: "system", content: systemRules },
      { role: "user", content: critiquePrompt },
    ],
    options: { ...modelOpt, temperature: Math.min(0.55, modelOpt.temperature + 0.05), num_predict: modelOpt.num_predict },
  });

  // Prefer refined if valid
  const rawPosts = Array.isArray(refined) ? refined : refined?.posts || draft?.posts || [];
  return rawPosts;
}

// ================== SD IMAGE PROMPT IMPROVER ==================
function enhanceImagePrompt({ topic, text, basePrompt, postKind }) {
  // Template ثابت يعطي نتائج أدق في SD
  // اجعل النص يعتمد على "موضوع + مشهد + مزاج + إضاءة + ستايل"
  const t = normalizeOneLine(topic || "");
  const k = postKind || "post";

  const moodByKind = {
    funny: "playful, witty mood",
    poetry: "moody, dreamy atmosphere",
    quotes: "minimal, calm mood",
    tips: "clean, helpful vibe",
    discussion: "modern social vibe",
    article: "editorial, informative mood",
    politics: "serious, respectful mood",
    question: "curious, engaging mood",
  };

  const mood = moodByKind[k] || "clean modern mood";

  // لو المودل أعطاك imagePrompt جيد، نكمله. لو فاضي، نعمل واحد بناءً على الموضوع
  const core =
    normalizeOneLine(basePrompt) ||
    `${t || "social life"}, person using smartphone, modern setting`;

  return [
    core,
    mood,
    "soft cinematic lighting",
    "shallow depth of field",
    "high detail",
    "clean composition",
    "no text, no logos, no watermark",
  ].join(", ");
}

async function sdTxt2Img({ prompt, negative_prompt, steps, cfg_scale, width, height, sampler_name }) {
  const payload = { prompt, negative_prompt, steps, cfg_scale, width, height, sampler_name };

  const r = await fetch(SD_TXT2IMG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}

  if (!r.ok) throw new Error(`SD error ${r.status}: ${text.slice(0, 300)}`);
  return data?.images?.[0];
}

// ================== ROUTES ==================
app.get("/health", async (req, res) => {
  try {
    const o = await fetch(OLLAMA_TAGS_URL);
    const ot = await o.text();
    const ollama = safeJsonParseMaybe(ot);

    const s = await fetch(SD_MODELS_URL);
    const st = await s.text();
    const sdModels = safeJsonParseMaybe(st);

    res.json({
      ok: true,
      model: MODEL,
      ollama: { url: OLLAMA_CHAT_URL, models: (ollama?.models || []).map((m) => m.name) },
      stableDiffusion: { url: SD_BASE_URL, modelsCount: Array.isArray(sdModels) ? sdModels.length : 0 },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/generate-posts", async (req, res) => {
  try {
    const count = clamp(req.body?.count ?? 10, 1, 50);
    const lines = clamp(req.body?.lines ?? 1, 1, 8);

    const category = String(req.body?.category ?? "General").slice(0, 120);
    const postKind = String(req.body?.postKind ?? "discussion");
    const lang = String(req.body?.lang ?? "ar");
    const tone = String(req.body?.tone ?? "natural").slice(0, 40);
    const allowEmojis = Boolean(req.body?.allowEmojis ?? true);

    const examples = String(req.body?.examples ?? "").slice(0, 1200);
    const description = String(req.body?.description ?? "").slice(0, 1200);

    const randomTopics = Boolean(req.body?.randomTopics ?? false);
    const randomTopicsCount = clamp(req.body?.randomTopicsCount ?? count, 2, 50);
    const topicsPoolRaw = String(req.body?.topicsPool ?? "").slice(0, 4000);

    const rawPosts = await generatePostsPro({
      count,
      lines,
      category,
      postKind,
      lang,
      tone,
      allowEmojis,
      examples,
      description,
      randomTopics,
      randomTopicsCount,
      topicsPoolRaw,
    });

    const ensureQuestionMark = postKind === "question";
    let posts = cleanPosts(rawPosts, { lang, ensureQuestionMark });

    // فلتر جودة بسيط: لو منشور ضعيف جدًا أعد ترتيبه/احذفه (اختياري)
    posts = posts.filter((p) => scoreWeakText(p.text) < 6);

    res.json({
      posts,
      meta: {
        countRequested: count,
        countReturned: posts.length,
        category,
        postKind,
        lang,
        lines,
        tone,
        allowEmojis,
        randomTopics,
      },
    });
  } catch (e) {
    console.error("Server error:", e);
    res.status(500).json({ error: "Server error", details: String(e), cause: String(e?.cause || "") });
  }
});

app.post("/generate-posts-with-images", async (req, res) => {
  try {
    const count = clamp(req.body?.count ?? 2, 1, 10);
    const lines = clamp(req.body?.lines ?? 1, 1, 8);

    const category = String(req.body?.category ?? "General").slice(0, 120);
    const postKind = String(req.body?.postKind ?? "discussion");
    const lang = String(req.body?.lang ?? "ar");
    const tone = String(req.body?.tone ?? "natural").slice(0, 40);
    const allowEmojis = Boolean(req.body?.allowEmojis ?? true);

    const examples = String(req.body?.examples ?? "").slice(0, 1200);
    const description = String(req.body?.description ?? "").slice(0, 1200);

    const randomTopics = Boolean(req.body?.randomTopics ?? false);
    const randomTopicsCount = clamp(req.body?.randomTopicsCount ?? count, 2, 50);
    const topicsPoolRaw = String(req.body?.topicsPool ?? "").slice(0, 4000);

    const sd = req.body?.sd || {};
    const sdParams = {
      steps: clamp(sd.steps ?? SD_DEFAULTS.steps, 12, 40),
      cfg_scale: Number(sd.cfg_scale ?? SD_DEFAULTS.cfg_scale),
      width: clamp(sd.width ?? SD_DEFAULTS.width, 384, 768),
      height: clamp(sd.height ?? SD_DEFAULTS.height, 384, 768),
      sampler_name: String(sd.sampler_name ?? SD_DEFAULTS.sampler_name),
    };

    const rawPosts = await generatePostsPro({
      count,
      lines,
      category,
      postKind,
      lang,
      tone,
      allowEmojis,
      examples,
      description,
      randomTopics,
      randomTopicsCount,
      topicsPoolRaw,
    });

    const ensureQuestionMark = postKind === "question";
    let posts = cleanPosts(rawPosts, { lang, ensureQuestionMark });
    posts = posts.filter((p) => scoreWeakText(p.text) < 6);

    // Generate images sequentially (VRAM safe)
    const out = [];
    for (const p of posts) {
      const finalPrompt = enhanceImagePrompt({
        topic: p.topic || category,
        text: p.text,
        basePrompt: p.imagePrompt,
        postKind,
      });

      const negative =
        p.negativePrompt ||
        "text, watermark, logo, signature, blurry, low quality, worst quality, jpeg artifacts, deformed, bad anatomy, extra fingers";

      const imageBase64 = await sdTxt2Img({
        prompt: finalPrompt,
        negative_prompt: negative,
        ...sdParams,
      });

      out.push({ ...p, imagePrompt: finalPrompt, imageBase64 });
    }

    res.json({
      posts: out,
      meta: {
        countRequested: count,
        countReturned: out.length,
        category,
        postKind,
        lang,
        lines,
        tone,
        allowEmojis,
        randomTopics,
        sdParams,
      },
    });
  } catch (e) {
    console.error("Server error:", e);
    res.status(500).json({ error: "Server error", details: String(e), cause: String(e?.cause || "") });
  }
});

// ================== START ==================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Backend running: http://127.0.0.1:${PORT}`);
  console.log(`Health check:     http://127.0.0.1:${PORT}/health`);
  console.log(`Posts:            POST http://127.0.0.1:${PORT}/generate-posts`);
  console.log(`Posts+Images:     POST http://127.0.0.1:${PORT}/generate-posts-with-images`);
});
