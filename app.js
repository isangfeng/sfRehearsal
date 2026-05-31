const scriptInput = document.querySelector("#script-input");
const lineList = document.querySelector("#line-list");
const lineTemplate = document.querySelector("#line-template");
const emptyState = document.querySelector("#empty-state");
const lineCount = document.querySelector("#line-count");
const voiceSelect = document.querySelector("#voice-select");
const speechProvider = document.querySelector("#speech-provider");
const meloTtsSpeed = document.querySelector("#melotts-speed");
const meloTtsOptions = document.querySelector("#melotts-options");
const elevenLabsOptions = document.querySelector("#elevenlabs-options");
const elevenLabsVoice = document.querySelector("#elevenlabs-voice");
const doubaoOptions = document.querySelector("#doubao-options");
const doubaoSpeed = document.querySelector("#doubao-speed");
const doubaoVoice = document.querySelector("#doubao-voice");
const browserOptions = document.querySelector("#browser-options");
const toast = document.querySelector("#toast");
const confirmBackdrop = document.querySelector("#confirm-backdrop");
const confirmMessage = document.querySelector("#confirm-message");
const confirmCancel = document.querySelector("#confirm-cancel");
const confirmOk = document.querySelector("#confirm-ok");
const historyPanel = document.querySelector("#history-panel");
const historyList = document.querySelector("#history-list");
const historyEmpty = document.querySelector("#history-empty");

const SETTINGS_KEY = "rehearsal_settings";
const MAX_HISTORY = 10;

const state = {
  lines: [],
  voices: [],
  activeRecorder: null,
  currentHistoryId: null,
  activeLineId: null,
  activeSpeechLineId: null,
  activeAudio: null,
  playbackFrame: null,
};

const exampleText = `台上并不需要完美，只需要你真的在场。
Take a breath. Look up, and begin again.
每一次排练，都是在找到更准确的表达。`;

function createLine(text) {
  return {
    id: crypto.randomUUID(),
    text,
    recordingBlob: null,
    recordingUrl: null,
    recordingPeaks: null,
    recordingSeekRatio: 0,
    naturalBlob: null,
    naturalUrl: null,
    naturalPeaks: null,
    naturalSeekRatio: 0,
  };
}

function getSavedSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}; } catch { return {}; }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      provider: speechProvider.value,
      melottsSpeed: meloTtsSpeed.value,
      doubaoSpeed: doubaoSpeed.value,
      doubaoVoice: doubaoVoice.value,
      elevenLabsVoice: elevenLabsVoice.value,
      browserVoice: voiceSelect.value,
    }));
  } catch {}
}

function loadSettings() {
  const saved = getSavedSettings();
  if (saved.provider) speechProvider.value = saved.provider;
  if (saved.melottsSpeed) meloTtsSpeed.value = saved.melottsSpeed;
  if (saved.doubaoSpeed) doubaoSpeed.value = saved.doubaoSpeed;
}

// ── IndexedDB helpers ──────────────────────────────────────────────────────

const DB_NAME = "rehearsal_db";
const DB_VERSION = 1;
const DB_STORE = "history";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
      req.onsuccess = () =>
        resolve([...req.result].sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
    });
  } catch { return []; }
}

async function dbGet(id) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(id);
      req.onsuccess = () => resolve(req.result ?? null);
    });
  } catch { return null; }
}

async function dbPut(entry) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(entry);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

async function dbDelete(id) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = resolve;
    });
  } catch {}
}

async function dbTrim() {
  const all = await dbGetAll();
  for (const item of all.slice(MAX_HISTORY)) await dbDelete(item.id);
}

// ── History CRUD ───────────────────────────────────────────────────────────

async function saveTextToHistory(text, lines) {
  if (!text.trim()) return;
  const all = await dbGetAll();
  const duplicate = all.find((item) => item.text === text);
  if (duplicate) await dbDelete(duplicate.id);
  const id = crypto.randomUUID();
  await dbPut({
    id,
    text,
    savedAt: new Date().toISOString(),
    lines: lines.map((line) => ({
      text: line.text,
      naturalBlob: null,
      naturalPeaks: null,
      recordingBlob: null,
      recordingPeaks: null,
    })),
  });
  state.currentHistoryId = id;
  await dbTrim();
  renderHistory();
}

async function updateHistoryAudio(line, type) {
  if (!state.currentHistoryId) return;
  const lineIndex = state.lines.indexOf(line);
  if (lineIndex === -1) return;
  const entry = await dbGet(state.currentHistoryId);
  if (!entry?.lines?.[lineIndex]) return;
  entry.lines[lineIndex][`${type}Blob`] = line[`${type}Blob`];
  entry.lines[lineIndex][`${type}Peaks`] = line[`${type}Peaks`];
  await dbPut(entry);
}

async function deleteHistoryItem(id) {
  await dbDelete(id);
  if (state.currentHistoryId === id) state.currentHistoryId = null;
  renderHistory();
}

async function loadHistoryEntry(id) {
  const entry = await dbGet(id);
  if (!entry) return;
  scriptInput.value = entry.text;
  historyPanel.hidden = true;
  if (!entry.lines?.length) return;
  stopSpeaking();
  stopAudioPlayback();
  stopRecording();
  revokeRecordingUrls();
  state.currentHistoryId = id;
  state.lines = entry.lines.map((saved) => {
    const line = createLine(saved.text);
    if (saved.naturalBlob) {
      line.naturalBlob = saved.naturalBlob;
      line.naturalUrl = URL.createObjectURL(saved.naturalBlob);
      line.naturalPeaks = saved.naturalPeaks;
    }
    if (saved.recordingBlob) {
      line.recordingBlob = saved.recordingBlob;
      line.recordingUrl = URL.createObjectURL(saved.recordingBlob);
      line.recordingPeaks = saved.recordingPeaks;
    }
    return line;
  });
  renderLines();
}

async function renderHistory() {
  const history = await dbGetAll();
  historyEmpty.hidden = history.length > 0;
  historyList.replaceChildren();
  history.forEach((item) => {
    const li = document.createElement("li");
    li.className = "history-item";

    const loadBtn = document.createElement("button");
    loadBtn.className = "history-item__load";
    loadBtn.type = "button";
    loadBtn.title = item.text;

    const preview = document.createElement("span");
    preview.className = "history-item__preview";
    preview.textContent = item.text.replace(/\s+/g, " ").trim().slice(0, 60);

    const dateSpan = document.createElement("span");
    dateSpan.className = "history-item__date";
    dateSpan.textContent = new Date(item.savedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });

    loadBtn.append(preview, dateSpan);
    loadBtn.addEventListener("click", () => loadHistoryEntry(item.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "history-item__delete";
    deleteBtn.type = "button";
    deleteBtn.setAttribute("aria-label", "删除此记录");
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", () => deleteHistoryItem(item.id));

    li.append(loadBtn, deleteBtn);
    historyList.append(li);
  });
}

function showConfirm(message, onConfirm, okLabel = "覆盖") {
  confirmMessage.textContent = message;
  confirmOk.textContent = okLabel;
  confirmBackdrop.hidden = false;
  confirmOk.focus();

  const cleanup = () => {
    confirmBackdrop.hidden = true;
    confirmCancel.removeEventListener("click", handleCancel);
    confirmOk.removeEventListener("click", handleOk);
    confirmBackdrop.removeEventListener("click", handleBackdrop);
    document.removeEventListener("keydown", handleKeydown);
  };
  const handleCancel = () => cleanup();
  const handleOk = () => { cleanup(); onConfirm(); };
  const handleBackdrop = (event) => { if (event.target === confirmBackdrop) cleanup(); };
  const handleKeydown = (event) => { if (event.key === "Escape") cleanup(); };

  confirmCancel.addEventListener("click", handleCancel);
  confirmOk.addEventListener("click", handleOk);
  confirmBackdrop.addEventListener("click", handleBackdrop);
  document.addEventListener("keydown", handleKeydown);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2800);
}

function splitIntoParagraphs(text) {
  return text
    .split(/\n\s*\n|\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitIntoSentences(text) {
  const paragraphs = splitIntoParagraphs(text);

  return paragraphs.flatMap((paragraph) => {
    if ("Segmenter" in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
      return [...segmenter.segment(paragraph)]
        .map(({ segment }) => segment.trim())
        .filter(Boolean);
    }

    return paragraph
      .match(/[^。！？!?；;.!]+[。！？!?；;.!]?/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [];
  });
}

function replaceLines(parts) {
  stopSpeaking();
  stopAudioPlayback();
  stopRecording();
  revokeRecordingUrls();
  state.lines = parts.map(createLine);
  renderLines();
}

function renderLines() {
  const scrollY = window.scrollY;
  lineList.replaceChildren();
  emptyState.hidden = state.lines.length > 0;
  lineCount.textContent = state.lines.length
    ? `${state.lines.length} 个排练片段`
    : "还没有拆分台词";

  state.lines.forEach((line, index) => {
    const card = lineTemplate.content.firstElementChild.cloneNode(true);
    const lineText = card.querySelector(".line-text");
    const status = card.querySelector(".recording-status");
    const naturalSpeakButton = card.querySelector(".natural-speak-button");
    const recordButton = card.querySelector(".record-button");
    const naturalWaveform = card.querySelector(".natural-waveform");
    const recordingWaveform = card.querySelector(".recording-waveform");
    const isSpeaking = state.activeSpeechLineId === line.id;
    const isRecording = state.activeLineId === line.id;

    card.dataset.lineId = line.id;
    card.querySelector(".line-number").textContent = String(index + 1).padStart(2, "0");
    lineText.value = line.text;
    naturalSpeakButton.title = speechProvider.value === "browser" ? "系统朗读" : "生成朗读";
    naturalSpeakButton.setAttribute("aria-label", naturalSpeakButton.title);
    naturalSpeakButton.disabled = Boolean(line.isGenerating);
    naturalSpeakButton.classList.toggle("is-active", Boolean(isSpeaking || line.isGenerating));
    recordButton.classList.toggle("is-active", isRecording);
    recordButton.title = isRecording ? "停止并保存录音" : "开始录音";
    recordButton.setAttribute("aria-label", recordButton.title);
    configureTrack(card, "natural", Boolean(line.naturalUrl), isSpeaking || line.isGenerating);
    configureTrack(card, "recording", Boolean(line.recordingUrl), isRecording);
    drawWaveform(naturalWaveform, line.naturalPeaks, `${line.id}-natural`, isSpeaking || line.isGenerating);
    drawWaveform(recordingWaveform, line.recordingPeaks, `${line.id}-recording`, isRecording);

    if (line.recordingUrl) {
      status.textContent = "录音已保存";
      status.classList.add("is-ready");
    } else if (isRecording) {
      status.textContent = "正在录音";
      status.classList.add("is-ready");
    } else if (line.naturalUrl) {
      status.textContent = "生成音频已保存";
      status.classList.add("is-ready");
    } else if (isSpeaking || line.isGenerating) {
      status.textContent = speechProvider.value === "browser" ? "正在朗读" : "正在生成";
      status.classList.add("is-ready");
    }

    lineText.addEventListener("input", (event) => {
      line.text = event.target.value;
    });
    naturalSpeakButton.addEventListener("click", (event) => {
      speakWithSelectedVoice(line, event.currentTarget);
    });
    recordButton.addEventListener("click", () => {
      toggleRecording(line.id);
    });
    configureSeekableWaveform(card, line, "natural");
    configureSeekableWaveform(card, line, "recording");
    card.querySelector(".clear-natural-button").addEventListener("click", () => clearAudio(line, "natural"));
    card.querySelector(".save-natural-button").addEventListener("click", () => saveAudio(line.naturalBlob, `rehearsal-generated-${index + 1}`));
    card.querySelector(".clear-recording-button").addEventListener("click", () => clearAudio(line, "recording"));
    card.querySelector(".save-recording-button").addEventListener("click", () => saveAudio(line.recordingBlob, `rehearsal-recording-${index + 1}`));
    card.querySelector(".delete-button").addEventListener("click", () => deleteLine(line.id));
    lineList.append(card);
  });
  window.scrollTo(0, scrollY);
}

function configureTrack(card, type, hasAudio, isActive) {
  const waveform = card.querySelector(`.${type}-waveform`);
  const placeholder = card.querySelector(`.${type}-track .track-placeholder`);
  const actions = card.querySelector(`.${type}-actions`);
  const playButton = card.querySelector(`.${type}-waveform-button`);
  waveform.hidden = !hasAudio && !isActive;
  placeholder.hidden = hasAudio || isActive;
  actions.hidden = !hasAudio;
  playButton.disabled = !hasAudio;
  updatePlayhead(lineSeekRatio(card.dataset.lineId, type), card.querySelector(`.${type}-playhead`));
}

function lineSeekRatio(lineId, type) {
  const line = state.lines.find((item) => item.id === lineId);
  return line?.[`${type}SeekRatio`] ?? 0;
}

function configureSeekableWaveform(card, line, type) {
  const button = card.querySelector(`.${type}-waveform-button`);
  let isSeeking = false;

  const movePlayhead = (event) => {
    if (!isSeeking) {
      return;
    }
    line[`${type}SeekRatio`] = pointerRatio(event, button);
    updatePlayhead(line[`${type}SeekRatio`], button.querySelector(`.${type}-playhead`));
  };

  button.addEventListener("pointerdown", (event) => {
    if (button.disabled) {
      return;
    }
    stopAudioPlayback();
    isSeeking = true;
    button.classList.add("is-dragging");
    button.setPointerCapture(event.pointerId);
    movePlayhead(event);
  });
  button.addEventListener("pointermove", movePlayhead);
  button.addEventListener("pointerup", (event) => {
    if (!isSeeking) {
      return;
    }
    movePlayhead(event);
    isSeeking = false;
    button.classList.remove("is-dragging");
    if (button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }
    playAudioFromRatio(line, type);
  });
  button.addEventListener("pointercancel", () => {
    isSeeking = false;
    button.classList.remove("is-dragging");
  });
}

function pointerRatio(event, element) {
  const bounds = element.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
}

function updatePlayhead(ratio, playhead) {
  playhead.style.left = `${ratio * 100}%`;
}

function drawWaveform(container, peaks, seed, isActive = false) {
  container.replaceChildren();
  container.classList.toggle("is-live", Boolean(isActive));
  for (let index = 0; index < 60; index += 1) {
    const bar = document.createElement("i");
    const character = seed.charCodeAt(index % seed.length);
    const height = peaks?.[index] ?? (0.22 + ((character * (index + 3)) % 72) / 100);
    bar.style.height = `${Math.max(0.12, height) * 100}%`;
    bar.style.animationDelay = `${(index % 8) * -90}ms`;
    container.append(bar);
  }
}

function deleteLine(lineId) {
  stopAudioPlayback();
  if (state.activeLineId === lineId) {
    stopRecording();
  }

  const line = state.lines.find((item) => item.id === lineId);
  if (line?.recordingUrl) {
    URL.revokeObjectURL(line.recordingUrl);
  }
  if (line?.naturalUrl) {
    URL.revokeObjectURL(line.naturalUrl);
  }

  state.lines = state.lines.filter((item) => item.id !== lineId);
  renderLines();
}

function loadVoices() {
  state.voices = window.speechSynthesis.getVoices();
  voiceSelect.replaceChildren();

  if (!state.voices.length) {
    voiceSelect.append(new Option("没有找到可用音色", ""));
    return;
  }

  state.voices.forEach((voice, index) => {
    const language = voice.lang ? ` · ${voice.lang}` : "";
    voiceSelect.append(new Option(`${voice.name}${language}`, String(index)));
  });

  const saved = getSavedSettings();
  if (saved.browserVoice) voiceSelect.value = saved.browserVoice;
}

function stopSpeaking() {
  window.speechSynthesis.cancel();
  if (state.activeSpeechLineId) {
    state.activeSpeechLineId = null;
    renderLines();
  }
}

function speak(line, confirmed = false) {
  if (!line.text.trim()) {
    showToast("这一句还是空的，请先输入文字。");
    return;
  }
  if (!confirmed && line.naturalUrl) {
    showConfirm("此句已有生成音频，使用浏览器朗读后将清除原有音频，是否继续？", () => speak(line, true), "继续");
    return;
  }

  stopSpeaking();
  stopAudioPlayback();
  if (line.naturalUrl) {
    URL.revokeObjectURL(line.naturalUrl);
    line.naturalUrl = null;
    line.naturalBlob = null;
    line.naturalPeaks = null;
    line.naturalSeekRatio = 0;
  }
  const utterance = new SpeechSynthesisUtterance(line.text);
  const selectedVoice = state.voices[Number(voiceSelect.value)];
  if (selectedVoice) {
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice.lang;
  }
  state.activeSpeechLineId = line.id;
  utterance.addEventListener("end", finishSpeaking);
  utterance.addEventListener("error", finishSpeaking);
  window.speechSynthesis.speak(utterance);
  renderLines();
}

function finishSpeaking() {
  state.activeSpeechLineId = null;
  renderLines();
}

function speakWithSelectedVoice(line, button) {
  if (speechProvider.value === "browser") {
    speak(line);
    return;
  }

  generateNaturalSpeech(line, button);
}

async function generateNaturalSpeech(line, button, confirmed = false) {
  if (!line.text.trim()) {
    showToast("这一句还是空的，请先输入文字。");
    return;
  }
  if (!confirmed && line.naturalUrl) {
    showConfirm("此句已有生成音频，是否重新生成并覆盖？", () => generateNaturalSpeech(line, button, true));
    return;
  }
  if (speechProvider.value === "elevenlabs" && !elevenLabsVoice.value) {
    showToast("请先配置 ElevenLabs API 密钥并选择在线音色。");
    return;
  }
  if (speechProvider.value === "doubao" && !doubaoVoice.value) {
    showToast("请先配置豆包语音并选择在线音色。");
    return;
  }

  button.disabled = true;
  line.isGenerating = true;
  renderLines();

  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: line.text,
        provider: speechProvider.value,
        speed: speechProvider.value === "doubao"
          ? Number(doubaoSpeed.value)
          : Number(meloTtsSpeed.value),
        voice_id: speechProvider.value === "doubao"
          ? doubaoVoice.value
          : elevenLabsVoice.value,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? "音频生成失败。");
    }

    if (line.naturalUrl) {
      URL.revokeObjectURL(line.naturalUrl);
    }
    line.naturalBlob = await response.blob();
    line.naturalUrl = URL.createObjectURL(line.naturalBlob);
    line.naturalPeaks = null;
    line.naturalSeekRatio = 0;
    line.isGenerating = false;
    renderLines();
    updateAudioPeaks(line, "natural", line.naturalBlob);
    playNaturalSpeech(line);
    showToast("音频已生成，可以直接导出。");
  } catch (error) {
    console.error(error);
    showToast(error.message);
    line.isGenerating = false;
    renderLines();
  }
}

async function loadProviderConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) {
      return;
    }
    const config = await response.json();
    const saved = getSavedSettings();
    if (!saved.melottsSpeed) meloTtsSpeed.value = String(config.melotts?.speed ?? 1);
    loadDoubaoConfig(config.doubao);
    await loadElevenLabsVoices(config.elevenlabs);
  } catch (error) {
    console.warn("无法载入语音配置。", error);
  }
}

async function loadElevenLabsVoices(config = {}) {
  elevenLabsVoice.replaceChildren();
  if (!config.enabled) {
    elevenLabsVoice.append(new Option("尚未配置 ElevenLabs API 密钥", ""));
    return;
  }

  elevenLabsVoice.append(new Option("正在加载在线音色……", ""));
  try {
    const response = await fetch("/api/elevenlabs/voices");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "ElevenLabs 音色载入失败。");
    }

    elevenLabsVoice.replaceChildren();
    if (!data.voices.length) {
      elevenLabsVoice.append(new Option("没有找到可用在线音色", ""));
      return;
    }
    data.voices.forEach((voice) => {
      elevenLabsVoice.append(new Option(voice.name, voice.voice_id));
    });
    elevenLabsVoice.value = data.selected_voice_id;
    const saved = getSavedSettings();
    if (saved.elevenLabsVoice) elevenLabsVoice.value = saved.elevenLabsVoice;
  } catch (error) {
    console.error(error);
    elevenLabsVoice.replaceChildren(new Option("在线音色载入失败", ""));
    showToast(error.message);
  }
}

function loadDoubaoConfig(config = {}) {
  const saved = getSavedSettings();
  if (!saved.doubaoSpeed) doubaoSpeed.value = String(config.speed ?? 1);
  doubaoVoice.replaceChildren();
  if (!config.enabled) {
    doubaoVoice.append(new Option("尚未完整配置豆包语音", ""));
    return;
  }
  config.voices.forEach((voice) => {
    doubaoVoice.append(new Option(voice.name, voice.voice_type));
  });
  doubaoVoice.value = config.selected_voice_type;
  if (saved.doubaoVoice) doubaoVoice.value = saved.doubaoVoice;
}

function updateProviderOptions() {
  const useElevenLabs = speechProvider.value === "elevenlabs";
  const useDoubao = speechProvider.value === "doubao";
  const useBrowser = speechProvider.value === "browser";
  meloTtsOptions.hidden = useElevenLabs || useDoubao || useBrowser;
  elevenLabsOptions.hidden = !useElevenLabs;
  doubaoOptions.hidden = !useDoubao;
  browserOptions.hidden = !useBrowser;
  renderLines();
}

async function toggleRecording(lineId, confirmed = false) {
  if (state.activeRecorder) {
    stopRecording();
    return;
  }

  const existingLine = state.lines.find((item) => item.id === lineId);
  if (!confirmed && existingLine?.recordingUrl) {
    showConfirm("此句已有录音，是否重新录制并覆盖？", () => toggleRecording(lineId, true));
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari。");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      const line = state.lines.find((item) => item.id === lineId);

      stream.getTracks().forEach((track) => track.stop());
      if (line) {
        if (line.recordingUrl) {
          URL.revokeObjectURL(line.recordingUrl);
        }
        line.recordingBlob = blob;
        line.recordingUrl = URL.createObjectURL(blob);
        line.recordingPeaks = null;
        line.recordingSeekRatio = 0;
      }

      state.activeRecorder = null;
      state.activeLineId = null;
      renderLines();
      if (line) {
        updateAudioPeaks(line, "recording", blob);
      }
      showToast("这一句的录音已经保存。");
    });

    recorder.start();
    state.activeRecorder = recorder;
    state.activeLineId = lineId;
    renderLines();
    showToast("正在录音，再次点击按钮即可保存。");
  } catch (error) {
    showToast("无法开始录音，请允许浏览器使用麦克风。");
  }
}

function stopRecording() {
  if (state.activeRecorder?.state === "recording") {
    state.activeRecorder.stop();
  }
}

function playRecording(line) {
  playAudioFromRatio(line, "recording");
}

function playNaturalSpeech(line) {
  playAudioFromRatio(line, "natural");
}

function playAudioFromRatio(line, type) {
  const url = line[`${type}Url`];
  if (!url) {
    return;
  }

  stopAudioPlayback();
  const audio = new Audio(url);
  const startPlayback = () => {
    audio.currentTime = (line[`${type}SeekRatio`] ?? 0) * audio.duration;
    audio.play();
    updatePlaybackProgress(line, type, audio);
  };
  state.activeAudio = audio;
  if (audio.readyState >= 1) {
    startPlayback();
  } else {
    audio.addEventListener("loadedmetadata", startPlayback, { once: true });
  }
  audio.addEventListener("ended", () => {
    line[`${type}SeekRatio`] = 0;
    stopAudioPlayback();
    updateLinePlayhead(line, type);
  }, { once: true });
}

function updatePlaybackProgress(line, type, audio) {
  const drawProgress = () => {
    if (state.activeAudio !== audio || audio.ended) {
      return;
    }
    line[`${type}SeekRatio`] = audio.duration ? audio.currentTime / audio.duration : 0;
    updateLinePlayhead(line, type);
    state.playbackFrame = requestAnimationFrame(drawProgress);
  };
  drawProgress();
}

function updateLinePlayhead(line, type) {
  const card = lineList.querySelector(`[data-line-id="${line.id}"]`);
  const playhead = card?.querySelector(`.${type}-playhead`);
  if (playhead) {
    updatePlayhead(line[`${type}SeekRatio`] ?? 0, playhead);
  }
}

function stopAudioPlayback() {
  if (state.activeAudio) {
    state.activeAudio.pause();
    state.activeAudio = null;
  }
  if (state.playbackFrame) {
    cancelAnimationFrame(state.playbackFrame);
    state.playbackFrame = null;
  }
}

function clearAudio(line, type) {
  stopAudioPlayback();
  const urlKey = `${type}Url`;
  const blobKey = `${type}Blob`;
  if (line[urlKey]) {
    URL.revokeObjectURL(line[urlKey]);
  }
  line[urlKey] = null;
  line[blobKey] = null;
  line[`${type}Peaks`] = null;
  line[`${type}SeekRatio`] = 0;
  renderLines();
}

async function updateAudioPeaks(line, type, blob) {
  const peaks = await extractWaveformPeaks(blob);
  if (line[`${type}Blob`] !== blob) {
    return;
  }
  line[`${type}Peaks`] = peaks;
  renderLines();
  updateHistoryAudio(line, type);
}

async function extractWaveformPeaks(blob) {
  try {
    const audioContext = new AudioContext();
    const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const samples = buffer.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(samples.length / 60));
    const peaks = Array.from({ length: 60 }, (_, index) => {
      const start = index * bucketSize;
      const end = Math.min(start + bucketSize, samples.length);
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        peak = Math.max(peak, Math.abs(samples[sampleIndex]));
      }
      return Math.max(0.12, peak);
    });
    await audioContext.close();
    return peaks;
  } catch (error) {
    console.warn("无法解析音频波形。", error);
    return null;
  }
}

function saveAudio(blob, filename) {
  if (!blob) {
    return;
  }
  const extension = blob.type.includes("wav")
    ? "wav"
    : blob.type.includes("mpeg")
      ? "mp3"
      : blob.type.includes("mp4")
        ? "m4a"
        : blob.type.includes("ogg")
          ? "ogg"
          : "webm";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}.${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function revokeRecordingUrls() {
  stopAudioPlayback();
  state.lines.forEach((line) => {
    if (line.recordingUrl) {
      URL.revokeObjectURL(line.recordingUrl);
    }
    if (line.naturalUrl) {
      URL.revokeObjectURL(line.naturalUrl);
    }
  });
}

async function exportRecordings() {
  const recordings = state.lines
    .map((line) => line.recordingBlob ?? line.naturalBlob)
    .filter(Boolean);
  if (!recordings.length) {
    showToast("还没有可导出的片段。请先录音或生成音频。");
    return;
  }

  try {
    const audioContext = new AudioContext();
    const buffers = [];
    for (const recording of recordings) {
      const bytes = await recording.arrayBuffer();
      buffers.push(await audioContext.decodeAudioData(bytes));
    }

    const wavBlob = mergeBuffersToWav(buffers);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(wavBlob);
    link.download = `rehearsal-${new Date().toISOString().slice(0, 10)}.wav`;
    link.click();
    URL.revokeObjectURL(link.href);
    await audioContext.close();
    showToast(`已导出 ${recordings.length} 个录音片段。`);
  } catch (error) {
    console.error(error);
    showToast("音频合并失败，请重试或换一个浏览器。");
  }
}

function mergeBuffersToWav(buffers) {
  const sampleRate = 44100;
  const pauseSeconds = 0.25;
  const pauseLength = Math.floor(sampleRate * pauseSeconds);
  const resampled = buffers.map((buffer) => resampleBuffer(buffer, sampleRate));
  const totalLength =
    resampled.reduce((sum, samples) => sum + samples.length, 0) +
    pauseLength * Math.max(resampled.length - 1, 0);
  const samples = new Float32Array(totalLength);
  let offset = 0;

  resampled.forEach((clip, index) => {
    samples.set(clip, offset);
    offset += clip.length;
    if (index < resampled.length - 1) {
      offset += pauseLength;
    }
  });

  return encodeWav(samples, sampleRate);
}

function resampleBuffer(buffer, targetRate) {
  const source = buffer.getChannelData(0);
  if (buffer.sampleRate === targetRate) {
    return source;
  }

  const ratio = buffer.sampleRate / targetRate;
  const result = new Float32Array(Math.round(source.length / ratio));
  for (let index = 0; index < result.length; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, source.length - 1);
    const mix = sourceIndex - left;
    result[index] = source[left] * (1 - mix) + source[right] * mix;
  }
  return result;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  samples.forEach((sample, index) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * bytesPerSample, clipped * 0x7fff, true);
  });

  return new Blob([view], { type: "audio/wav" });
}

function writeAscii(view, offset, text) {
  [...text].forEach((character, index) => {
    view.setUint8(offset + index, character.charCodeAt(0));
  });
}

document.querySelector("#load-example").addEventListener("click", () => {
  scriptInput.value = exampleText;
});

document.querySelector("#split-sentences").addEventListener("click", () => {
  const parts = splitIntoSentences(scriptInput.value);
  if (!parts.length) {
    showToast("请先输入一些文字。");
    return;
  }
  replaceLines(parts);
  saveTextToHistory(scriptInput.value, state.lines);
});

document.querySelector("#split-paragraphs").addEventListener("click", () => {
  const parts = splitIntoParagraphs(scriptInput.value);
  if (!parts.length) {
    showToast("请先输入一些文字。");
    return;
  }
  replaceLines(parts);
  saveTextToHistory(scriptInput.value, state.lines);
});

document.querySelector("#toggle-history").addEventListener("click", () => {
  historyPanel.hidden = !historyPanel.hidden;
});

document.querySelector("#export-recordings").addEventListener("click", exportRecordings);
speechProvider.addEventListener("change", () => { updateProviderOptions(); saveSettings(); });
meloTtsSpeed.addEventListener("change", saveSettings);
doubaoSpeed.addEventListener("change", saveSettings);
doubaoVoice.addEventListener("change", saveSettings);
elevenLabsVoice.addEventListener("change", saveSettings);
voiceSelect.addEventListener("change", saveSettings);
window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
window.addEventListener("beforeunload", revokeRecordingUrls);

loadSettings();
loadVoices();
updateProviderOptions();
loadProviderConfig();
renderLines();
renderHistory();
