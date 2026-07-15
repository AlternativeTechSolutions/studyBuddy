require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple local persistence — one JSON file per generated set, no DB needed for MVP
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// --- Extract text from an uploaded file (PDF or plain text) ---
async function extractText(file) {
  if (file.mimetype === 'application/pdf') {
    const parsed = await pdfParse(file.buffer);
    return parsed.text;
  }
  return file.buffer.toString('utf-8');
}

// --- Stream generation: writes live tokens to the HTTP response as Gemini produces them ---
async function streamStudyMaterials(sourceText, title, res) {
  if (!GEMINI_API_KEY) {
    throw new Error('No GEMINI_API_KEY configured. Copy .env.example to .env and add your key from https://aistudio.google.com/apikey');
  }

  const systemPrompt = `You are a study material generator. Given source text, produce a study guide and flashcards.
Respond with ONLY valid JSON, no markdown fences, no preamble, matching this exact shape:
{
  "title": "string",
  "summary": "string, 2-3 sentences",
  "studyGuide": "string, markdown-formatted, with headings and key term definitions, 300-600 words",
  "flashcards": [ { "question": "string", "answer": "string" } ]
}`;

  // Gemini's free-tier context window is far larger than a local model's — safe to send much more source text
  const truncated = sourceText.slice(0, 100000);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

  let geminiRes;
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [
          {
            role: 'user',
            parts: [{ text: `Source material title hint: ${title || '(untitled)'}\n\nSource text:\n\n${truncated}` }]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json', // Gemini's native JSON mode — more reliable than prompt instructions alone
          // maxOutputTokens: 4000
        }
      })
    });
  } catch (err) {
    throw new Error(`Could not reach the Gemini API. Check your internet connection. (${err.message})`);
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    if (geminiRes.status === 429) {
      throw new Error('Gemini free-tier rate limit hit (requests/minute or requests/day). Wait a bit and try again.');
    }
    if (geminiRes.status === 400 && errText.includes('API_KEY_INVALID')) {
      throw new Error('Your GEMINI_API_KEY looks invalid. Double-check it in .env against https://aistudio.google.com/apikey');
    }
    throw new Error(`Gemini request failed (${geminiRes.status}): ${errText.slice(0, 300)}`);
  }

  let raw = '';
  let usage = {};
  const reader = geminiRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep any incomplete trailing line for the next chunk

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue; // Gemini SSE format — every event is prefixed "data: "
      const jsonStr = line.slice(6).trim();
      if (!jsonStr) continue;

      let obj;
      try {
        obj = JSON.parse(jsonStr);
      } catch {
        continue; // partial/malformed event, skip
      }

      const textPart = obj.candidates?.[0]?.content?.parts?.[0]?.text;
      if (textPart) {
        raw += textPart;
        res.write(JSON.stringify({ type: 'token', text: textPart }) + '\n');
      }
      if (obj.usageMetadata) {
        usage = {
          input_tokens: obj.usageMetadata.promptTokenCount ?? null,
          output_tokens: obj.usageMetadata.candidatesTokenCount ?? null,
        };
      }
    }
  }

  raw = raw.trim();
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Model did not return valid JSON.\n' + raw.slice(0, 500));
  }

  return { ...parsed, usage };
}

// --- Routes ---

app.post('/api/generate', upload.single('file'), async (req, res) => {
  let sourceText = req.body.text || '';
  try {
    if (req.file) {
      sourceText = await extractText(req.file);
    }

    if (!sourceText || sourceText.trim().length < 50) {
      return res.status(400).json({ error: 'Please provide at least a few sentences of source material.' });
    }

    // Chunked plain-text response — each line is its own JSON event the browser reads as it arrives
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    });

    const result = await streamStudyMaterials(sourceText, req.body.title, res);

    const id = Date.now().toString();
    const record = { id, createdAt: new Date().toISOString(), ...result };
    fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(record, null, 2));

    res.write(JSON.stringify({ type: 'done', record }) + '\n');
    res.end();
  } catch (err) {
    console.error(err);
    // If headers are already sent (streaming started), report the error as a stream event instead of an HTTP status
    if (res.headersSent) {
      res.write(JSON.stringify({ type: 'error', message: err.message || 'Generation failed.' }) + '\n');
      res.end();
    } else {
      res.status(500).json({ error: err.message || 'Generation failed.' });
    }
  }
});

app.get('/api/sets', (req, res) => {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  const sets = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f))))
    .sort((a, b) => b.id - a.id);
  res.json(sets);
});

app.get('/api/sets/:id', (req, res) => {
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(fs.readFileSync(filePath)));
});

app.delete('/api/sets/:id', (req, res) => {
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ deleted: true });
});

app.listen(PORT, () => {
  console.log(`Study Buddy MVP running at http://localhost:${PORT}`);
});
