/* ══════════════════════════════════════════════════════════════════════════
   Cúntóir AI Gaeilge — browser app (static, GitHub Pages compatible)

   All the Python services are reimplemented here in JavaScript:
     - abair ASR  : POST https://recognition.abair.ie/v3-5/transcribe
     - abair TTS  : GET  https://synthesis.abair.ie/api/synthesise
     - Abair COMHRÁ: POST https://www.abair.ie/api/s2s
     - Gemini     : POST generativelanguage.googleapis.com

   Conversations and settings are stored in the browser's localStorage.
   ══════════════════════════════════════════════════════════════════════════ */

// ── Config (mirrors config.py) ───────────────────────────────────────────────

const VOICES = [
  { label: "Sibéal (Conamara, F)",     voice: "ga_CO_snc_piper" },
  { label: "Áine (Dún na nGall, F)",   voice: "ga_UL_anb_piper" },
  { label: "Dónall (Dún na nGall, M)", voice: "ga_UL_doc_piper" },
  { label: "Neasa (Ciarraí, F)",       voice: "ga_MU_nnc_piper" },
  { label: "Colm (Ciarraí, M)",        voice: "ga_MU_cmg_piper" },
  { label: "Danny (Ciarraí, M)",       voice: "ga_MU_dms_piper" },
  { label: "Fianait (Na Déise, F)",    voice: "ga_MU_fnm_piper" },
];
const DEFAULT_VOICE = VOICES[0];

const ABAIR_ASR_URL    = "https://recognition.abair.ie/v3-5/transcribe";
const ABAIR_TTS_URL    = "https://synthesis.abair.ie/api/synthesise";
const ABAIR_COMHRA_URL = "https://www.abair.ie/api/s2s";
const GEMINI_MODEL     = "gemini-2.5-flash";

// ── COMHRÁ proxy ──────────────────────────────────────────────────────────────
// abair's COMHRÁ endpoint blocks direct browser calls (no CORS headers).
// Set this to your deployed Cloudflare Worker URL to enable COMHRÁ in the
// browser. Leave it as "" to call abair directly (works on desktop /
// same-origin, but fails on GitHub Pages with a CORS error).
// Example: "https://cuntoir-comhra.your-name.workers.dev"
const COMHRA_PROXY_URL = "https://cuntoir-comhra.japanesethrowaway1337.workers.dev/";

const SYSTEM_PROMPT =
  "Is cúntóir Gaeilge thú. Labhraíonn tú i nGaeilge amháin. " +
  "Freagair i nGaeilge, le do thoil, agus bí gonta, soiléir agus cabharthach.";

// ── Storage keys ──────────────────────────────────────────────────────────────
const LS_CONVOS  = "gaeilge_convos";   // {name: [{role, content}, ...]}
const LS_CURRENT = "gaeilge_current";  // name of active convo
const LS_PREFS   = "gaeilge_prefs";    // {ai, voice}
const LS_GEMINI  = "gaeilge_gemini_key";

// ══════════════════════════════════════════════════════════════════════════
// Conversation manager (localStorage-backed, mirrors conversation_manager.py)
// ══════════════════════════════════════════════════════════════════════════

const Convos = {
  _all() {
    try { return JSON.parse(localStorage.getItem(LS_CONVOS)) || {}; }
    catch { return {}; }
  },
  _save(all) { localStorage.setItem(LS_CONVOS, JSON.stringify(all)); },

  list() {
    const names = Object.keys(this._all());
    names.sort((a, b) => {
      const na = parseInt((a.match(/(\d+)$/) || [])[1]);
      const nb = parseInt((b.match(/(\d+)$/) || [])[1]);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
    return names;
  },

  _nextName() {
    const nums = this.list()
      .map(n => (n.match(/^Comhrá (\d+)$/) || [])[1])
      .filter(Boolean).map(Number);
    return `Comhrá ${nums.length ? Math.max(...nums) + 1 : 1}`;
  },

  current() { return localStorage.getItem(LS_CURRENT); },
  setCurrent(name) { localStorage.setItem(LS_CURRENT, name); },

  messages(name) { return this._all()[name] || []; },

  create() {
    const name = this._nextName();
    const all = this._all();
    all[name] = [];
    this._save(all);
    this.setCurrent(name);
    return name;
  },

  addUser(text) {
    const all = this._all(); const name = this.current();
    if (!all[name]) all[name] = [];
    all[name].push({ role: "user", content: text });
    this._save(all);
  },

  addAssistant(text) {
    const all = this._all(); const name = this.current();
    if (!all[name]) all[name] = [];
    all[name].push({ role: "assistant", content: text });
    this._save(all);
  },

  popLast() {
    const all = this._all(); const name = this.current();
    if (all[name] && all[name].length) { all[name].pop(); this._save(all); }
  },

  rename(oldName, newName) {
    const all = this._all();
    if (!all[oldName] || all[newName]) return false;
    all[newName] = all[oldName];
    delete all[oldName];
    this._save(all);
    if (this.current() === oldName) this.setCurrent(newName);
    return true;
  },

  delete(name) {
    const all = this._all();
    if (!all[name]) return false;
    delete all[name];
    this._save(all);
    if (this.current() === name) localStorage.removeItem(LS_CURRENT);
    return true;
  },

  displayText(name) {
    return this.messages(name).map(m =>
      (m.role === "user" ? "Tú: " : "AI: ") + m.content
    ).join("\n\n");
  },
};

// ══════════════════════════════════════════════════════════════════════════
// Services
// ══════════════════════════════════════════════════════════════════════════

async function transcribeAudio(blob) {
  const ext = blob.type.includes("ogg") ? "ogg"
            : blob.type.includes("mp4") ? "mp4" : "webm";
  const fd = new FormData();
  fd.append("file", blob, `recording.${ext}`);
  fd.append("captpunct", "true");
  const r = await fetch(ABAIR_ASR_URL, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`ASR HTTP ${r.status}`);
  const data = await r.json();
  const text = (data.text || "").trim();
  if (!text) throw new Error("Empty transcript");
  return text;
}

async function synthesizeSpeech(text, voiceId) {
  const url = `${ABAIR_TTS_URL}?input=${encodeURIComponent(text)}` +
              `&voice=${encodeURIComponent(voiceId)}&normalise=true`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TTS HTTP ${r.status}`);
  const data = await r.json();
  if (!data.audioContent) throw new Error("No audioContent");
  return data.audioContent; // base64 WAV
}

async function getAiResponse(messages, aiName) {
  if (aiName === "Gemini") return callGemini(messages);
  if (aiName === "Abair COMHRÁ") return callAbairComhra(messages);
  return null;
}

async function callGemini(messages) {
  const key = localStorage.getItem(LS_GEMINI) || "";
  if (!key) return "Cuir isteach eochair Gemini i Socruithe ar dtús.";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/` +
              `${GEMINI_MODEL}:generateContent?key=${key}`;
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    // Let Gemini search the web to answer real-world questions
    // (local schools, raising bilingual children, etc.)
    tools: [{ google_search: {} }],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.7,
      // Thinking stays ON (default budget) so it can reason through
      // complex questions. We filter the thinking out below.
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("Gemini error", r.status, t);
    return null;
  }
  const data = await r.json();
  return extractGeminiText(data);
}

// Pull only the final answer text out of a Gemini response, skipping any
// "thought" parts that the thinking phase produces.
function extractGeminiText(data) {
  try {
    const parts = data.candidates[0].content.parts || [];
    const answer = parts
      .filter(p => p && typeof p.text === "string" && p.thought !== true)
      .map(p => p.text)
      .join("")
      .trim();
    return answer || null;
  } catch (e) {
    console.error("Gemini parse error", e, data);
    return null;
  }
}

async function callAbairComhra(messages) {
  // Use the Cloudflare Worker proxy if configured; otherwise hit abair
  // directly (which will fail on GitHub Pages due to CORS).
  const target = COMHRA_PROXY_URL || ABAIR_COMHRA_URL;
  const r = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!r.ok) { console.error("COMHRÁ HTTP", r.status); return null; }
  const data = await r.json();
  if (data.messages) {
    for (let i = data.messages.length - 1; i >= 0; i--) {
      if (data.messages[i].role === "assistant")
        return (data.messages[i].content || "").trim();
    }
  }
  for (const f of ["text", "response", "reply", "output", "message", "content"]) {
    if (data[f]) return String(data[f]).trim();
  }
  return null;
}

let currentAudio = null;
let currentAudioResolve = null;

function playBase64Wav(b64) {
  return new Promise(resolve => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    const audio = new Audio(url);
    currentAudio = audio;
    currentAudioResolve = resolve;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) { currentAudio = null; currentAudioResolve = null; }
      resolve();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    audio.play().catch(cleanup);
  });
}

function stopPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  // Resolve the awaiting promise in askAI so its flow completes cleanly
  if (currentAudioResolve) {
    const r = currentAudioResolve;
    currentAudioResolve = null;
    r();
  }
}

// Stop the TTS playback (does not start a new recording).
function stopAudioPlayback() {
  stopPlayback();
  $("stopAudioBtn").disabled = true;
  if (isProcessing) {
    isProcessing = false;
    $("recordBtn").disabled = false;
    updateSeolState();
  }
  setStatus("Stopadh an fhuaim.");
}

// Download the current conversation as a .txt file.
function downloadConversation() {
  const name = Convos.current();
  const msgs = Convos.messages(name);
  if (!msgs.length) { setStatus("Níl aon rud le híoslódáil."); return; }

  let text = `# ${name}\n\n`;
  msgs.forEach(m => {
    text += (m.role === "user" ? "Tú: " : "AI: ") + m.content + "\n\n";
  });

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════════════════
// UI logic
// ══════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

let isRecording = false;
let isProcessing = false;
let seiceailOn = false;
let mediaRecorder = null;
let audioChunks = [];
let micStream = null;
let audioCtx = null, analyser = null, meterTimer = null;
let thinkingTimer = null;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Populate voices
  VOICES.forEach(v => {
    const o = document.createElement("option");
    o.value = v.voice; o.textContent = v.label;
    $("voiceSelect").appendChild(o);
  });

  // Restore prefs
  const prefs = JSON.parse(localStorage.getItem(LS_PREFS) || "{}");
  if (prefs.ai)    $("aiSelect").value = prefs.ai;
  if (prefs.voice) $("voiceSelect").value = prefs.voice;
  $("geminiKey").value = localStorage.getItem(LS_GEMINI) || "";

  // Conversations
  let names = Convos.list();
  if (!names.length) { Convos.create(); names = Convos.list(); }
  if (!Convos.current() || !names.includes(Convos.current()))
    Convos.setCurrent(names[names.length - 1]);
  refreshConvoSelect();
  refreshHistory();

  wireEvents();
  setStatus("Brúigh chun tosú.");
});

function wireEvents() {
  $("recordBtn").onclick = toggleRecording;
  $("seolBtn").onclick = seolPressed;
  $("seiceailBtn").onclick = toggleSeiceail;
  $("settingsBtn").onclick = () => $("settingsModal").classList.add("show");
  $("newConvoBtn").onclick = newConversation;
  $("stopAudioBtn").onclick = stopAudioPlayback;
  $("downloadBtn").onclick = downloadConversation;

  $("convoSelect").onchange = onConvoChange;

  $("aiSelect").onchange = savePrefs;
  $("voiceSelect").onchange = savePrefs;

  $("messageEdit").addEventListener("input", updateSeolState);
  $("messageEdit").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); seolPressed(); }
  });

  // Settings modal
  $("saveSettingsBtn").onclick = () => {
    localStorage.setItem(LS_GEMINI, $("geminiKey").value.trim());
    $("settingsStatus").textContent = "Sábháilte!";
    setTimeout(() => $("settingsStatus").textContent = "", 2000);
  };
  $("closeSettingsBtn").onclick = () => $("settingsModal").classList.remove("show");

  // Right-click on conversation dropdown → rename/delete menu
  $("convoSelect").addEventListener("contextmenu", e => {
    e.preventDefault();
    const name = $("convoSelect").value;
    if (!name) return;
    showCtxMenu(e.clientX, e.clientY, [
      ["Athainmnigh...", () => openRename(name)],
      ["Scrios...", () => openDelete(name)],
    ]);
  });

  // Global: Escape closes modals/menus, stops audio, cancels recording
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      hideCtxMenu();
      document.querySelectorAll(".modal-overlay.show")
        .forEach(m => m.classList.remove("show"));
      if (currentAudio) { stopAudioPlayback(); return; }
      if (isRecording) cancelRecording();
    }
    if (e.ctrlKey && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      if (!isProcessing) newConversation();
    }
  });

  // Hide context menu on any click
  document.addEventListener("click", hideCtxMenu);

  // Rename modal buttons
  $("renameCancelBtn").onclick = () => $("renameModal").classList.remove("show");
  $("deleteCancelBtn").onclick = () => $("deleteModal").classList.remove("show");
}

// ── Conversations ─────────────────────────────────────────────────────────────

function refreshConvoSelect() {
  const sel = $("convoSelect");
  sel.innerHTML = "";
  Convos.list().forEach(n => {
    const o = document.createElement("option");
    o.value = n; o.textContent = n;
    if (n === Convos.current()) o.selected = true;
    sel.appendChild(o);
  });
}

function onConvoChange() {
  if (isProcessing) { refreshConvoSelect(); return; }
  Convos.setCurrent($("convoSelect").value);
  refreshHistory();
  $("transcriptBox").textContent = "";
}

function newConversation() {
  if (isProcessing) return;
  Convos.create();
  refreshConvoSelect();
  refreshHistory();
  $("transcriptBox").textContent = "";
}

function refreshHistory() {
  const box = $("historyBox");
  box.innerHTML = "";
  Convos.messages(Convos.current()).forEach(m => {
    const div = document.createElement("div");
    const lbl = document.createElement("span");
    lbl.className = m.role === "user" ? "msg-user" : "msg-ai";
    lbl.textContent = (m.role === "user" ? "Tú" : "AI") + ": ";
    div.appendChild(lbl);
    div.appendChild(document.createTextNode(m.content));
    div.style.marginBottom = "8px";
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight; // auto-scroll to newest
}

// ── Recording ─────────────────────────────────────────────────────────────────

async function toggleRecording() {
  if (isProcessing) return;
  if (!isRecording) await startRecording();
  else stopRecording();
}

async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus("Ní féidir an micreafón a rochtain: " + e.message);
    return;
  }
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  meterTimer = setInterval(updateMeter, 50);

  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  mediaRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : {});
  audioChunks = [];
  mediaRecorder.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
  mediaRecorder.start(100);

  isRecording = true;
  $("recordBtn").textContent = "Stop";
  $("transcriptBox").textContent = "";
  setStatus("Ag éisteacht...");
}

function stopRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.onstop = processAudio;
  mediaRecorder.stop();
  cleanupMic();
  isRecording = false;
  isProcessing = true;
  $("recordBtn").textContent = "Tosaigh ag Taifeadadh";
  $("recordBtn").disabled = true;
  setStatus("Ag próiseáil...");
}

function cancelRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.onstop = null;
  try { mediaRecorder.stop(); } catch {}
  cleanupMic();
  isRecording = false;
  $("recordBtn").textContent = "Tosaigh ag Taifeadadh";
  setStatus("Cealaithe.");
}

function cleanupMic() {
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (meterTimer) clearInterval(meterTimer);
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  $("meterFill").style.width = "0%";
}

function updateMeter() {
  if (!analyser) return;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(buf);
  const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
  $("meterFill").style.width = Math.min(100, avg * 2) + "%";
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

async function processAudio() {
  startThinking("Ag aithint cainte");
  const mime = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
  const blob = new Blob(audioChunks, { type: mime });
  let transcript;
  try {
    transcript = await transcribeAudio(blob);
  } catch (e) {
    return done("Níor éirigh leis an aithint. Bain triail eile as.");
  }
  $("transcriptBox").textContent = "Tú: " + transcript;

  if (seiceailOn) {
    stopThinking();
    isProcessing = false;
    $("messageEdit").value = transcript;
    $("recordBtn").disabled = false;
    updateSeolState();
    setStatus("Cuir an téacs in eagar, ansin brúigh Seol.");
    return;
  }
  await askAI(transcript);
}

async function askAI(transcript) {
  const aiName = $("aiSelect").value;
  const voiceId = $("voiceSelect").value;

  startThinking("Ag cur ceiste ar " + aiName);
  Convos.addUser(transcript);

  let response;
  try {
    response = await getAiResponse(Convos.messages(Convos.current()), aiName);
  } catch (e) {
    Convos.popLast();
    // COMHRÁ needs the proxy on a hosted site; give a clear hint.
    if (aiName === "Abair COMHRÁ" && !COMHRA_PROXY_URL) {
      return done("Teastaíonn seachfhreastalaí (proxy) le COMHRÁ a úsáid ar an ngréasán. Bain triail as Gemini.");
    }
    return done("Earráid AI: " + e.message);
  }
  if (!response) { Convos.popLast(); return done("Níor tháinig freagra ón AI."); }

  Convos.addAssistant(response);
  refreshHistory();

  startThinking("Ag léamh an fhreagra");
  try {
    const b64 = await synthesizeSpeech(response, voiceId);
    stopThinking();
    setStatus("Ag léamh an fhreagra... (brúigh Stop an Fhuaim chun stopadh)");
    $("stopAudioBtn").disabled = false;
    await playBase64Wav(b64);
    $("stopAudioBtn").disabled = true;
  } catch (e) { /* speech failed, text still shown */ }

  done("Ullamh. Brúigh chun tosú arís.");
}

function seolPressed() {
  const text = $("messageEdit").value.trim();
  if (!text || isProcessing) return;
  isProcessing = true;
  $("recordBtn").disabled = true;
  $("seolBtn").disabled = true;
  $("messageEdit").value = "";
  askAI(text);
}

// ── Seiceáil Théacs ───────────────────────────────────────────────────────────

function toggleSeiceail() {
  seiceailOn = !seiceailOn;
  $("seiceailBtn").textContent = seiceailOn
    ? "Seiceáil Théacs: ON" : "Seiceáil Théacs: OFF";
}

// ── Status + thinking animation ────────────────────────────────────────────────

function setStatus(msg) { $("statusBar").textContent = msg; }

function startThinking(base) {
  stopThinking();
  let dots = 0;
  setStatus(base);
  thinkingTimer = setInterval(() => {
    dots = (dots + 1) % 4;
    setStatus(base + ".".repeat(dots));
  }, 400);
}
function stopThinking() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
}

function done(msg) {
  stopThinking();
  setStatus(msg);
  isProcessing = false;
  $("recordBtn").disabled = false;
  $("stopAudioBtn").disabled = true;
  updateSeolState();
}

function updateSeolState() {
  const hasText = $("messageEdit").value.trim().length > 0;
  $("seolBtn").disabled = !hasText || isProcessing;
}

function savePrefs() {
  localStorage.setItem(LS_PREFS, JSON.stringify({
    ai: $("aiSelect").value,
    voice: $("voiceSelect").value,
  }));
}

// ── Rename / delete modals ─────────────────────────────────────────────────────

function openRename(name) {
  hideCtxMenu();
  const modal = $("renameModal");
  $("renameInput").value = name;
  $("renameStatus").textContent = "";
  modal.classList.add("show");
  $("renameInput").focus();

  $("renameOkBtn").onclick = () => {
    const newName = $("renameInput").value.trim();
    if (!newName) { $("renameStatus").textContent = "Ainm folamh."; return; }
    if (newName === name) { modal.classList.remove("show"); return; }
    if (!Convos.rename(name, newName)) {
      $("renameStatus").textContent = "Tá an t-ainm sin ann cheana."; return;
    }
    refreshConvoSelect();
    refreshHistory();
    modal.classList.remove("show");
  };
  $("renameInput").onkeydown = e => {
    if (e.key === "Enter") $("renameOkBtn").click();
  };
}

function openDelete(name) {
  hideCtxMenu();
  const modal = $("deleteModal");
  $("deleteMsg").textContent =
    `An bhfuil tú cinnte gur mian leat '${name}' a scrios?`;
  modal.classList.add("show");

  $("deleteOkBtn").onclick = () => {
    Convos.delete(name);
    let names = Convos.list();
    if (!names.length) { Convos.create(); names = Convos.list(); }
    if (!Convos.current()) Convos.setCurrent(names[names.length - 1]);
    refreshConvoSelect();
    refreshHistory();
    modal.classList.remove("show");
  };
}

// ── Context menu ────────────────────────────────────────────────────────────────

function showCtxMenu(x, y, items) {
  const menu = $("ctxMenu");
  menu.innerHTML = "";
  items.forEach(([label, cb]) => {
    const d = document.createElement("div");
    d.textContent = label;
    d.onclick = ev => { ev.stopPropagation(); hideCtxMenu(); cb(); };
    menu.appendChild(d);
  });
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.classList.add("show");
}
function hideCtxMenu() { $("ctxMenu").classList.remove("show"); }
