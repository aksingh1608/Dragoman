/* Dragoman offline PWA — audio capture, PTT, TTS, phrasebook */

(() => {
  "use strict";

  const MAX_SECONDS = 15;
  const TARGET_RATE = 16000;
  const PEAK_SILENCE = 200;

  const els = {
    voiceBanner: document.getElementById("voiceBanner"),
    stateDe: document.getElementById("stateDe"),
    stateEn: document.getElementById("stateEn"),
    sourceDe: document.getElementById("sourceDe"),
    targetDe: document.getElementById("targetDe"),
    sourceEn: document.getElementById("sourceEn"),
    targetEn: document.getElementById("targetEn"),
    metaDe: document.getElementById("metaDe"),
    metaEn: document.getElementById("metaEn"),
    pttDe: document.getElementById("pttDe"),
    pttEn: document.getElementById("pttEn"),
    repeatDe: document.getElementById("repeatDe"),
    repeatEn: document.getElementById("repeatEn"),
    levelDe: document.getElementById("levelDe"),
    levelEn: document.getElementById("levelEn"),
    levelDeWrap: document.getElementById("levelDeWrap"),
    levelEnWrap: document.getElementById("levelEnWrap"),
    btnPhrases: document.getElementById("btnPhrases"),
    btnHealth: document.getElementById("btnHealth"),
    btnMicTest: document.getElementById("btnMicTest"),
    healthDot: document.getElementById("healthDot"),
    drawer: document.getElementById("drawer"),
    drawerBackdrop: document.getElementById("drawerBackdrop"),
    phraseList: document.getElementById("phraseList"),
  };

  const state = {
    busy: false,
    recording: false,
    micTest: false,
    direction: null,
    lastDe: "",
    lastEn: "",
    voicesReady: false,
    voiceDe: null,
    voiceEn: null,
    phrasebook: [],
    audioCtx: null,
    mediaStream: null,
    workletNode: null,
    sourceNode: null,
    muteNode: null,
    pcmChunks: [],
    inputRate: TARGET_RATE,
    micReady: false,
    recStartedAt: 0,
    maxTimer: null,
    levelSide: null,
    // Streaming upload while held
    sessionId: null,
    streamCursor: 0,
    chunkTimer: null,
    uploadChain: Promise.resolve(),
    useStream: true,
  };

  function setStatePill(side, name) {
    const pill = side === "de" ? els.stateDe : els.stateEn;
    pill.textContent = name;
    pill.className = "state-pill " + name.toLowerCase();
  }

  function setBothIdle() {
    setStatePill("de", "Idle");
    setStatePill("en", "Idle");
  }

  function showBanner(msg) {
    els.voiceBanner.textContent = msg;
    els.voiceBanner.classList.add("show");
  }

  function hideBanner() {
    els.voiceBanner.classList.remove("show");
  }

  /** Prefer on-device voices so speech still works with Wi‑Fi / mobile data off. */
  function preferLocal(list) {
    const local = list.filter((v) => v.localService === true);
    return local.length ? local : list;
  }

  function pickVoices() {
    if (!window.speechSynthesis) {
      showBanner(
        "No speechSynthesis on this browser. Install Chrome, then install offline DE + EN voice data (Google Text-to-speech → Install voice data)."
      );
      return;
    }
    const voices = window.speechSynthesis.getVoices() || [];
    const de = preferLocal(voices.filter((v) => /^de(-|_|$)/i.test(v.lang)));
    const en = preferLocal(voices.filter((v) => /^en(-|_|$)/i.test(v.lang)));
    state.voiceDe =
      de.find((v) => /de-DE/i.test(v.lang) && v.localService) ||
      de.find((v) => /de-DE/i.test(v.lang)) ||
      de[0] ||
      null;
    state.voiceEn =
      en.find((v) => /en-(GB|US)/i.test(v.lang) && v.localService) ||
      en.find((v) => /en-GB/i.test(v.lang)) ||
      en.find((v) => /en-US/i.test(v.lang)) ||
      en[0] ||
      null;
    state.voicesReady = !!(state.voiceDe || state.voiceEn);
    const missing = [];
    if (!state.voiceDe) missing.push("German (de-DE)");
    if (!state.voiceEn) missing.push("English (en-US / en-GB)");
    const notLocal =
      (state.voiceDe && state.voiceDe.localService === false) ||
      (state.voiceEn && state.voiceEn.localService === false);
    if (missing.length) {
      showBanner(
        "Missing offline TTS voice(s): " +
          missing.join(", ") +
          ". Open Google Text-to-speech → gear → Install voice data → download Deutsch + English, then reopen Dragoman."
      );
    } else if (notLocal) {
      showBanner(
        "TTS voices look online-only — speech may fail with no internet. Install offline voice data in Google Text-to-speech, then reopen."
      );
    } else {
      hideBanner();
    }
  }

  function speak(text, lang) {
    return new Promise((resolve) => {
      if (!text || !window.speechSynthesis) {
        resolve();
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (lang === "de") {
        u.lang = "de-DE";
        if (state.voiceDe) u.voice = state.voiceDe;
      } else {
        u.lang = state.voiceEn && /en-GB/i.test(state.voiceEn.lang) ? "en-GB" : "en-US";
        if (state.voiceEn) u.voice = state.voiceEn;
      }
      u.rate = 1.0;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      // Android: small delay helps when voices just loaded offline.
      try {
        window.speechSynthesis.speak(u);
      } catch (_) {
        resolve();
      }
    });
  }

  /** Correct 44-byte RIFF WAV: PCM=1, mono, 16-bit, 16000 Hz, byteRate=32000, blockAlign=2 */
  function writeWavHeader(view, sampleCount, sampleRate) {
    const dataSize = sampleCount * 2;
    const setStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    setStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    setStr(8, "WAVE");
    setStr(12, "fmt ");
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byteRate
    view.setUint16(32, 2, true); // blockAlign
    view.setUint16(34, 16, true); // bits
    setStr(36, "data");
    view.setUint32(40, dataSize, true);
  }

  /** Linear-interpolation resample to TARGET_RATE. Never claim 16 kHz unless resampled. */
  function resampleLinear(float32, inputRate) {
    if (inputRate === TARGET_RATE) return float32;
    const ratio = inputRate / TARGET_RATE;
    const outLen = Math.max(1, Math.floor(float32.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, float32.length - 1);
      const frac = src - i0;
      out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
    }
    return out;
  }

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function int16Stats(pcm16) {
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < pcm16.length; i++) {
      const a = Math.abs(pcm16[i]);
      if (a > peak) peak = a;
      sumSq += pcm16[i] * pcm16[i];
    }
    const rms = pcm16.length ? Math.sqrt(sumSq / pcm16.length) : 0;
    return { peak, rms };
  }

  function buildWavFromChunks(pcmChunks, inputRate) {
    let total = 0;
    for (const c of pcmChunks) total += c.length;
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of pcmChunks) {
      merged.set(c, off);
      off += c.length;
    }
    const down = resampleLinear(merged, inputRate);
    const pcm16 = floatTo16BitPCM(down);
    const { peak, rms } = int16Stats(pcm16);
    const durationMs = (pcm16.length / TARGET_RATE) * 1000;
    const buffer = new ArrayBuffer(44 + pcm16.length * 2);
    const view = new DataView(buffer);
    writeWavHeader(view, pcm16.length, TARGET_RATE);
    let o = 44;
    for (let i = 0; i < pcm16.length; i++, o += 2) {
      view.setInt16(o, pcm16[i], true);
    }
    const blob = new Blob([buffer], { type: "audio/wav" });
    return { blob, peak, rms, durationMs, sampleRate: TARGET_RATE, inputRate };
  }

  async function resumeCtx() {
    if (state.audioCtx && state.audioCtx.state === "suspended") {
      await state.audioCtx.resume();
    }
  }

  /** Request mic once at page load; keep stream + AudioContext + Worklet warm. */
  async function initMic() {
    if (state.micReady) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      // Do NOT pass sampleRate — Chrome on Android ignores it and often runs at 48000.
      const audioCtx = new Ctx();
      await audioCtx.audioWorklet.addModule("/recorder-worklet.js");
      if (audioCtx.state === "suspended") {
        try {
          await audioCtx.resume();
        } catch (_) {
          /* may need a user gesture; resume again on first press */
        }
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, "recorder-processor");
      const mute = audioCtx.createGain();
      mute.gain.value = 0;

      worklet.port.onmessage = (ev) => {
        if (!state.recording) return;
        const samples = ev.data;
        if (!(samples instanceof Float32Array)) return;
        state.pcmChunks.push(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        if (state.levelSide) updateLevel(state.levelSide, rms);
      };

      source.connect(worklet);
      worklet.connect(mute);
      mute.connect(audioCtx.destination);

      state.mediaStream = stream;
      state.audioCtx = audioCtx;
      state.sourceNode = source;
      state.workletNode = worklet;
      state.muteNode = mute;
      state.inputRate = audioCtx.sampleRate;
      state.micReady = true;
      console.log("[mic] ready, AudioContext.sampleRate=" + state.inputRate);
      els.metaEn.textContent = "Mic ready · " + state.inputRate + " Hz (resample→16000)";
    } catch (err) {
      console.error(err);
      showBanner("Microphone permission denied. Allow mic access for this page, then reload.");
      throw err;
    }
  }

  function updateLevel(side, rms) {
    const bar = side === "de" ? els.levelDe : els.levelEn;
    const wrap = side === "de" ? els.levelDeWrap : els.levelEnWrap;
    const pct = Math.min(100, Math.round(rms * 280));
    bar.style.width = pct + "%";
    wrap.classList.add("active");
  }

  function clearLevel(side) {
    if (!side) return;
    const bar = side === "de" ? els.levelDe : els.levelEn;
    const wrap = side === "de" ? els.levelDeWrap : els.levelEnWrap;
    bar.style.width = "0%";
    wrap.classList.remove("active");
  }

  function newSessionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function samplesHeld() {
    let n = 0;
    for (let i = 0; i < state.pcmChunks.length; i++) n += state.pcmChunks[i].length;
    return n;
  }

  function takeFloatRange(start, end) {
    const out = new Float32Array(Math.max(0, end - start));
    let pos = 0;
    let idx = 0;
    for (let c = 0; c < state.pcmChunks.length; c++) {
      const chunk = state.pcmChunks[c];
      const chunkStart = idx;
      const chunkEnd = idx + chunk.length;
      const lo = Math.max(start, chunkStart);
      const hi = Math.min(end, chunkEnd);
      if (hi > lo) {
        out.set(chunk.subarray(lo - chunkStart, hi - chunkStart), pos);
        pos += hi - lo;
      }
      idx = chunkEnd;
      if (idx >= end) break;
    }
    return out;
  }

  function enqueueUpload(fn) {
    state.uploadChain = state.uploadChain.then(fn).catch((err) => {
      console.error("[stream] upload error", err);
    });
    return state.uploadChain;
  }

  async function postStreamChunk(sessionId, floatSlice, inputRate) {
    if (!floatSlice.length) return;
    const built = buildWavFromChunks([floatSlice], inputRate);
    const body = new FormData();
    body.append("audio", built.blob, "chunk.wav");
    const res = await fetch("/api/stream/" + encodeURIComponent(sessionId) + "/chunk", {
      method: "POST",
      body,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error("chunk upload failed: " + res.status + " " + t);
    }
  }

  function flushStreamChunk() {
    if (!state.sessionId || state.micTest) return;
    // ~1 second of samples at the AudioContext rate
    const need = Math.floor(state.inputRate * 1.0);
    const total = samplesHeld();
    if (total - state.streamCursor < need) return;
    const start = state.streamCursor;
    const end = start + need;
    const slice = takeFloatRange(start, end);
    state.streamCursor = end;
    const sid = state.sessionId;
    const rate = state.inputRate;
    enqueueUpload(() => postStreamChunk(sid, slice, rate));
  }

  async function flushRemainingAndFinish(direction) {
    const sid = state.sessionId;
    const rate = state.inputRate;
    const total = samplesHeld();
    if (sid && total > state.streamCursor) {
      const slice = takeFloatRange(state.streamCursor, total);
      state.streamCursor = total;
      enqueueUpload(() => postStreamChunk(sid, slice, rate));
    }
    await state.uploadChain;
    const body = new FormData();
    body.append("direction", direction);
    const res = await fetch("/api/stream/" + encodeURIComponent(sid) + "/finish", {
      method: "POST",
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || res.statusText || "stream finish failed");
    }
    return data;
  }

  async function startCollecting(direction, opts) {
    opts = opts || {};
    if (state.busy || state.recording) return false;
    try {
      await initMic();
      await resumeCtx();
    } catch (_) {
      return false;
    }
    if (!state.workletNode) {
      showBanner("AudioWorklet not available.");
      return false;
    }

    state.recording = true;
    state.micTest = !!opts.micTest;
    state.direction = direction;
    state.pcmChunks = [];
    state.recStartedAt = performance.now();
    state.levelSide = direction === "de-en" ? "de" : "en";
    state.sessionId = state.micTest ? null : newSessionId();
    state.streamCursor = 0;
    state.uploadChain = Promise.resolve();

    state.workletNode.port.postMessage({ cmd: "start" });

    const side = state.levelSide;
    if (!state.micTest) {
      const btn = side === "de" ? els.pttDe : els.pttEn;
      btn.classList.add("held");
      setStatePill(side, "Listening");
      setStatePill(side === "de" ? "en" : "de", "Idle");
      if (state.chunkTimer) clearInterval(state.chunkTimer);
      state.chunkTimer = setInterval(flushStreamChunk, 250);
    } else {
      setStatePill("en", "Listening");
      els.metaEn.textContent = "MIC TEST recording…";
    }

    const limitMs = (opts.seconds || MAX_SECONDS) * 1000 + 50;
    state.maxTimer = setTimeout(() => {
      if (state.recording) {
        if (state.micTest) {
          return;
        }
        stopRecordingAndSend();
      }
    }, limitMs);
    return true;
  }

  function stopCollecting() {
    if (!state.recording) return null;
    state.recording = false;
    if (state.maxTimer) {
      clearTimeout(state.maxTimer);
      state.maxTimer = null;
    }
    if (state.chunkTimer) {
      clearInterval(state.chunkTimer);
      state.chunkTimer = null;
    }
    if (state.workletNode) {
      state.workletNode.port.postMessage({ cmd: "stop" });
    }
    els.pttDe.classList.remove("held");
    els.pttEn.classList.remove("held");
    const side = state.levelSide;
    clearLevel(side);
    const chunks = state.pcmChunks.slice();
    const inputRate = state.inputRate;
    const wasMicTest = state.micTest;
    const direction = state.direction;
    const sessionId = state.sessionId;
    state.micTest = false;
    return { chunks, inputRate, wasMicTest, direction, side, sessionId };
  }

  async function startRecording(direction) {
    await startCollecting(direction, { seconds: MAX_SECONDS, micTest: false });
  }

  async function stopRecordingAndSend() {
    const result = stopCollecting();
    if (!result) return;
    const { chunks, inputRate, wasMicTest, direction, side, sessionId } = result;

    if (!chunks.length) {
      setBothIdle();
      showBanner("No audio captured");
      state.sessionId = null;
      return;
    }

    const built = buildWavFromChunks(chunks, inputRate);
    console.log(
      "[audio] inputRate=" +
        built.inputRate +
        " peak=" +
        Math.round(built.peak) +
        " rms=" +
        Math.round(built.rms) +
        " durationMs=" +
        Math.round(built.durationMs) +
        " session=" +
        (sessionId || "-")
    );

    if (wasMicTest) {
      await finishMicTest(built);
      return;
    }

    if (built.peak < PEAK_SILENCE) {
      showBanner("No audio captured");
      setBothIdle();
      (side === "de" ? els.metaDe : els.metaEn).textContent =
        "peak " + Math.round(built.peak) + " · rms " + Math.round(built.rms) + " — not sent";
      state.sessionId = null;
      return;
    }
    hideBanner();

    // Prefer streaming finish (chunks already uploaded during hold).
    if (state.useStream && sessionId) {
      state.busy = true;
      els.pttDe.disabled = true;
      els.pttEn.disabled = true;
      const thinkSide = direction === "de-en" ? "de" : "en";
      const speakSide = direction === "de-en" ? "en" : "de";
      setStatePill(thinkSide, "Thinking");
      setStatePill(speakSide, "Thinking");
      try {
        // Flush any remainder still in the local buffer, then finish.
        // streamCursor is still valid until we clear session.
        const data = await flushRemainingAndFinish(direction);
        state.sessionId = null;
        state.pcmChunks = [];
        if (data.skipped) {
          applyResult(direction, data);
          (thinkSide === "de" ? els.metaDe : els.metaEn).textContent =
            formatMeta(data) || "Skipped";
          setBothIdle();
          return;
        }
        applyResult(direction, data);
        const toSpeak = data.target_text || "";
        const lang = direction === "de-en" ? "en" : "de";
        setStatePill(speakSide, "Speaking");
        setStatePill(thinkSide, "Idle");
        await speak(toSpeak, lang);
        setBothIdle();
      } catch (err) {
        console.warn("[stream] falling back to /api/translate", err);
        state.sessionId = null;
        await translateBlob(built.blob, direction);
        return;
      } finally {
        state.busy = false;
        els.pttDe.disabled = false;
        els.pttEn.disabled = false;
        state.pcmChunks = [];
        state.sessionId = null;
      }
      return;
    }

    state.pcmChunks = [];
    state.sessionId = null;
    await translateBlob(built.blob, direction);
  }

  async function finishMicTest(built) {
    const msg =
      "MIC TEST · peak " +
      Math.round(built.peak) +
      " · rms " +
      Math.round(built.rms) +
      " · " +
      Math.round(built.durationMs) +
      " ms · in " +
      built.inputRate +
      "→16000";
    els.metaEn.textContent = msg;
    els.metaDe.textContent = msg;
    console.log("[mic-test]", msg);
    if (built.peak < PEAK_SILENCE) {
      showBanner("No audio captured");
      setBothIdle();
      state.busy = false;
      return;
    }
    hideBanner();
    setStatePill("en", "Speaking");
    try {
      const url = URL.createObjectURL(built.blob);
      const audio = new Audio(url);
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
    setBothIdle();
    state.busy = false;
  }

  function applyResult(direction, data) {
    if (direction === "de-en") {
      els.sourceDe.textContent = data.source_text || "";
      els.targetDe.textContent = data.target_text || "";
      els.sourceEn.textContent = data.source_text || "";
      els.targetEn.textContent = data.target_text || "";
      els.metaDe.textContent = formatMeta(data);
      els.metaEn.textContent = formatMeta(data);
      state.lastEn = data.target_text || "";
      state.lastDe = data.source_text || "";
      els.repeatEn.disabled = !state.lastEn;
      els.repeatDe.disabled = !state.lastDe;
    } else {
      els.sourceEn.textContent = data.source_text || "";
      els.targetEn.textContent = data.target_text || "";
      els.sourceDe.textContent = data.source_text || "";
      els.targetDe.textContent = data.target_text || "";
      els.metaDe.textContent = formatMeta(data);
      els.metaEn.textContent = formatMeta(data);
      state.lastDe = data.target_text || "";
      state.lastEn = data.source_text || "";
      els.repeatDe.disabled = !state.lastDe;
      els.repeatEn.disabled = !state.lastEn;
    }
  }

  function formatMeta(data) {
    if (!data) return "";
    const s = data.stages || {};
    const bits = [];
    if (s.whisper_ms != null) bits.push("whisper " + s.whisper_ms);
    const llm = s.llm_ms != null ? s.llm_ms : s.llama_ms;
    if (llm != null) bits.push("llm " + llm);
    const total = data.ms != null ? data.ms : s.total_ms;
    if (total != null) bits.push("total " + total);
    if (data.skipped && data.reason) bits.push("skipped:" + data.reason);
    return bits.join(" · ");
  }

  async function translateBlob(wav, direction) {
    state.busy = true;
    els.pttDe.disabled = true;
    els.pttEn.disabled = true;
    const thinkSide = direction === "de-en" ? "de" : "en";
    const speakSide = direction === "de-en" ? "en" : "de";
    setStatePill(thinkSide, "Thinking");
    setStatePill(speakSide, "Thinking");

    const body = new FormData();
    body.append("audio", wav, "audio.wav");
    body.append("direction", direction);

    try {
      const res = await fetch("/api/translate", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.detail || res.statusText || "translate failed";
        (thinkSide === "de" ? els.metaDe : els.metaEn).textContent = String(msg);
        setBothIdle();
        return;
      }
      if (data.skipped) {
        applyResult(direction, data);
        (thinkSide === "de" ? els.metaDe : els.metaEn).textContent =
          formatMeta(data) || "Skipped";
        setBothIdle();
        return;
      }
      applyResult(direction, data);
      const toSpeak = data.target_text || "";
      const lang = direction === "de-en" ? "en" : "de";
      setStatePill(speakSide, "Speaking");
      setStatePill(thinkSide, "Idle");
      await speak(toSpeak, lang);
      setBothIdle();
    } catch (err) {
      (thinkSide === "de" ? els.metaDe : els.metaEn).textContent =
        "Network/bridge error: " + (err && err.message ? err.message : err);
      setBothIdle();
    } finally {
      state.busy = false;
      els.pttDe.disabled = false;
      els.pttEn.disabled = false;
    }
  }

  function bindPtt(btn, direction) {
    const start = (ev) => {
      ev.preventDefault();
      if (state.busy) return;
      startRecording(direction);
    };
    const end = (ev) => {
      ev.preventDefault();
      if (state.recording && state.direction === direction && !state.micTest) {
        stopRecordingAndSend();
      }
    };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", end);
    btn.addEventListener("pointerleave", (ev) => {
      if (state.recording && state.direction === direction && !state.micTest && ev.buttons === 0) {
        end(ev);
      }
    });
  }

  bindPtt(els.pttDe, "de-en");
  bindPtt(els.pttEn, "en-de");

  els.repeatDe.addEventListener("click", async () => {
    if (!state.lastDe || state.busy) return;
    setStatePill("de", "Speaking");
    await speak(state.lastDe, "de");
    setStatePill("de", "Idle");
  });

  els.repeatEn.addEventListener("click", async () => {
    if (!state.lastEn || state.busy) return;
    setStatePill("en", "Speaking");
    await speak(state.lastEn, "en");
    setStatePill("en", "Idle");
  });

  async function runMicTest() {
    if (state.busy || state.recording) return;
    state.busy = true;
    hideBanner();
    els.pttDe.disabled = true;
    els.pttEn.disabled = true;
    // Disable auto maxTimer finish that only calls stopCollecting — we own the 3s window.
    const ok = await startCollecting("en-de", { seconds: 30, micTest: true });
    if (!ok) {
      state.busy = false;
      els.pttDe.disabled = false;
      els.pttEn.disabled = false;
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
    if (state.recording && state.micTest) {
      await stopRecordingAndSend();
    } else {
      state.busy = false;
    }
    els.pttDe.disabled = false;
    els.pttEn.disabled = false;
  }

  els.btnMicTest.addEventListener("click", (ev) => {
    ev.preventDefault();
    runMicTest();
  });

  function openDrawer() {
    els.drawer.classList.add("open");
    els.drawerBackdrop.classList.add("open");
  }

  function closeDrawer() {
    els.drawer.classList.remove("open");
    els.drawerBackdrop.classList.remove("open");
  }

  els.btnPhrases.addEventListener("click", openDrawer);
  els.drawerBackdrop.addEventListener("click", closeDrawer);

  async function loadPhrasebook() {
    try {
      const res = await fetch("/phrasebook.json", { cache: "no-store" });
      state.phrasebook = await res.json();
    } catch (_) {
      state.phrasebook = [];
    }
    renderPhrasebook();
  }

  function renderPhrasebook() {
    els.phraseList.innerHTML = "";
    state.phrasebook.forEach((row) => {
      const li = document.createElement("li");
      const en = document.createElement("div");
      en.className = "phrase-en";
      en.textContent = row.en || "";
      const de = document.createElement("div");
      de.className = "phrase-de";
      de.textContent = row.de || "";
      const btnEn = document.createElement("button");
      btnEn.type = "button";
      btnEn.textContent = "Speak EN";
      btnEn.addEventListener("click", async () => {
        closeDrawer();
        state.lastEn = row.en || "";
        els.repeatEn.disabled = !state.lastEn;
        els.sourceEn.textContent = row.en || "";
        els.targetEn.textContent = row.de || "";
        els.sourceDe.textContent = row.en || "";
        els.targetDe.textContent = row.de || "";
        setStatePill("en", "Speaking");
        await speak(row.en || "", "en");
        setStatePill("en", "Idle");
      });
      const btnDe = document.createElement("button");
      btnDe.type = "button";
      btnDe.textContent = "Speak DE";
      btnDe.addEventListener("click", async () => {
        closeDrawer();
        state.lastDe = row.de || "";
        els.repeatDe.disabled = !state.lastDe;
        els.sourceDe.textContent = row.en || "";
        els.targetDe.textContent = row.de || "";
        els.sourceEn.textContent = row.en || "";
        els.targetEn.textContent = row.de || "";
        setStatePill("de", "Speaking");
        await speak(row.de || "", "de");
        setStatePill("de", "Idle");
      });
      li.appendChild(en);
      li.appendChild(btnEn);
      li.appendChild(btnDe);
      li.appendChild(de);
      els.phraseList.appendChild(li);
    });
  }

  async function checkHealth() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      els.healthDot.className = "health-dot " + (data.ok ? "ok" : "bad");
      els.btnHealth.title =
        "whisper=" + data.whisper + " llama=" + data.llama;
    } catch (_) {
      els.healthDot.className = "health-dot bad";
    }
  }

  els.btnHealth.addEventListener("click", checkHealth);

  if (window.speechSynthesis) {
    pickVoices();
    window.speechSynthesis.onvoiceschanged = pickVoices;
  } else {
    pickVoices();
  }

  loadPhrasebook();
  checkHealth();
  setInterval(checkHealth, 15000);

  // Warm the mic graph once at load (do not wait for first PTT).
  initMic().catch(() => {});

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
