const statusEl = document.getElementById('status');
const generateBtn = document.getElementById('generateBtn');
const setsList = document.getElementById('setsList');
const results = document.getElementById('results');

let currentSet = null;
let cardIndex = 0;

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}

async function loadSets() {
  const res = await fetch('/api/sets');
  const sets = await res.json();
  setsList.innerHTML = '';
  if (sets.length === 0) {
    setsList.innerHTML = '<li style="cursor:default">No study sets yet.</li>';
    return;
  }
  sets.forEach((s) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = s.title || '(untitled)';
    label.onclick = () => showSet(s);
    const del = document.createElement('span');
    del.textContent = '✕';
    del.className = 'del';
    del.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/sets/${s.id}`, { method: 'DELETE' });
      loadSets();
    };
    li.appendChild(label);
    li.appendChild(del);
    setsList.appendChild(li);
  });
}

function showSet(set) {
  currentSet = set;
  cardIndex = 0;
  results.classList.remove('hidden');
  document.getElementById('resultTitle').textContent = set.title || '(untitled)';
  document.getElementById('resultSummary').textContent = set.summary || '';
  if (set.usage) {
    document.getElementById('resultUsage').textContent =
      `Tokens used: ${set.usage.input_tokens} in / ${set.usage.output_tokens} out`;
  }
  document.getElementById('guideContent').innerHTML = renderMarkdown(set.studyGuide || '');
  renderCard();
  results.scrollIntoView({ behavior: 'smooth' });
}

// Minimal markdown renderer — headings, bold, bullet lists. No external dep needed for MVP.
function renderMarkdown(md) {
  return md
    .split('\n')
    .map((line) => {
      if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`;
      if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
      if (line.startsWith('# ')) return `<h1>${line.slice(2)}</h1>`;
      if (line.startsWith('- ')) return `<li>${line.slice(2)}</li>`;
      if (line.trim() === '') return '<br/>';
      return `<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`;
    })
    .join('\n');
}

function renderCard() {
  if (!currentSet || !currentSet.flashcards || currentSet.flashcards.length === 0) return;
  const card = currentSet.flashcards[cardIndex];
  const inner = document.querySelector('.flashcard-inner');
  inner.classList.remove('flipped');
  document.querySelector('.flashcard-front').textContent = card.question;
  document.querySelector('.flashcard-back').textContent = card.answer;
  document.getElementById('cardCounter').textContent =
    `Card ${cardIndex + 1} / ${currentSet.flashcards.length}`;
}

document.querySelector('.flashcard-inner').addEventListener('click', () => {
  document.querySelector('.flashcard-inner').classList.toggle('flipped');
});
document.getElementById('flipCard').onclick = () =>
  document.querySelector('.flashcard-inner').classList.toggle('flipped');
document.getElementById('nextCard').onclick = () => {
  if (!currentSet) return;
  cardIndex = (cardIndex + 1) % currentSet.flashcards.length;
  renderCard();
};
document.getElementById('prevCard').onclick = () => {
  if (!currentSet) return;
  cardIndex = (cardIndex - 1 + currentSet.flashcards.length) % currentSet.flashcards.length;
  renderCard();
};

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`${btn.dataset.tab}Tab`).classList.remove('hidden');
  };
});

generateBtn.onclick = async () => {
  const title = document.getElementById('title').value;
  const text = document.getElementById('text').value;
  const fileInput = document.getElementById('file');

  if (!text.trim() && !fileInput.files[0]) {
    setStatus('Paste some text or choose a file first.', 'error');
    return;
  }

  const liveOutputPanel = document.getElementById('liveOutputPanel');
  const liveOutput = document.getElementById('liveOutput');
  liveOutput.textContent = '';
  liveOutputPanel.classList.remove('hidden');

  generateBtn.disabled = true;
  setStatus('Generating... calling the Gemini API, usually takes a few seconds.');

  try {
    const formData = new FormData();
    formData.append('title', title);
    formData.append('text', text);
    if (fileInput.files[0]) formData.append('file', fileInput.files[0]);

    const res = await fetch('/api/generate', { method: 'POST', body: formData });

    // A non-streaming error (e.g. validation failure) arrives as plain JSON before headers commit to streaming
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok && contentType.includes('application/json')) {
      const data = await res.json();
      throw new Error(data.error || 'Generation failed');
    }

    // Read the response as a stream of newline-delimited JSON events
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalRecord = null;
    let streamError = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // last (possibly incomplete) line stays in the buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);

        if (event.type === 'token') {
          liveOutput.textContent += event.text;
          liveOutput.scrollTop = liveOutput.scrollHeight; // auto-scroll as it grows
        } else if (event.type === 'done') {
          finalRecord = event.record;
        } else if (event.type === 'error') {
          streamError = event.message;
        }
      }
    }

    if (streamError) throw new Error(streamError);
    if (!finalRecord) throw new Error('Stream ended without a result.');

    setStatus('Done!', 'success');
    await loadSets();
    showSet(finalRecord);
    liveOutputPanel.classList.add('hidden'); // collapse the raw view once the formatted result is shown
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    generateBtn.disabled = false;
  }
};

loadSets();
