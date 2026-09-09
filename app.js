/* ============================================================
   AUS Policy Assistant — application logic
   ============================================================ */

(() => {
  "use strict";

  // ---- Storage keys (browser-local only) ----
  const LS_KEY   = "aus_gemini_key";
  const LS_MODEL = "aus_gemini_model";
  const LS_CHAT  = "aus_chat_history";

  // Current, available Gemini Flash models (free tier). Older ones were retired.
  const MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"];
  const DEFAULT_MODEL = "gemini-3.5-flash";
  function currentModel() {
    const m = localStorage.getItem(LS_MODEL);
    return MODELS.indexOf(m) !== -1 ? m : DEFAULT_MODEL; // ignore any retired saved model
  }

  // ---- State ----
  let history = loadHistory();   // [{role:'user'|'assistant', text, sources, inHandbook}]
  let busy = false;
  let controller = null;         // AbortController for the in-flight request

  const SEND_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 12 L20 12 M13 5 L20 12 L13 19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const STOP_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>';

  // ---- Elements ----
  const thread        = document.getElementById("thread");
  const welcome       = document.getElementById("welcome");
  const form          = document.getElementById("composerForm");
  const input         = document.getElementById("input");
  const sendBtn       = document.getElementById("sendBtn");
  const micBtn        = document.getElementById("micBtn");
  const newChatBtn    = document.getElementById("newChatBtn");
  const settingsBtn   = document.getElementById("settingsBtn");
  const overlay       = document.getElementById("settingsOverlay");
  const apiKeyInput   = document.getElementById("apiKeyInput");
  const modelSelect   = document.getElementById("modelSelect");
  const settingsSave  = document.getElementById("settingsSave");
  const settingsCancel= document.getElementById("settingsCancel");

  // ============================================================
  //  Handbook retrieval — send only the relevant pages per question
  //  so requests stay under the free tier's ~250k tokens/minute limit.
  // ============================================================
  const FULL_LIMIT     = 60000;  // if the whole handbook is <= this many chars, send it all
  const RETRIEVE_LIMIT = 42000;  // otherwise send up to ~this many chars of the best-matching pages

  let _chunks = null;
  function getChunks() {
    if (_chunks) return _chunks;
    _chunks = [];
    const re = /\[\[PAGE (\d+)\]\]/g;
    const marks = [];
    let m;
    while ((m = re.exec(HANDBOOK_TEXT)) !== null) {
      marks.push({ page: +m[1], textStart: re.lastIndex, start: m.index });
    }
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].start : HANDBOOK_TEXT.length;
      _chunks.push({ page: marks[i].page, text: HANDBOOK_TEXT.slice(marks[i].textStart, end).trim() });
    }
    if (!_chunks.length) _chunks.push({ page: null, text: HANDBOOK_TEXT });
    return _chunks;
  }

  function handbookForQuery(question) {
    if (HANDBOOK_TEXT.length <= FULL_LIMIT) return HANDBOOK_TEXT;  // small handbook: send it whole
    const chunks = getChunks();
    const terms = (question.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    const scored = chunks.map(c => {
      const lc = c.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let idx = lc.indexOf(t);
        while (idx !== -1) { score++; idx = lc.indexOf(t, idx + t.length); }
      }
      return { c, score };
    }).sort((a, b) => b.score - a.score);

    const out = [];
    let size = 0;
    for (const { c, score } of scored) {
      if (score === 0) break;
      const piece = (c.page ? `[[PAGE ${c.page}]]\n` : "") + c.text;
      if (out.length && size + piece.length > RETRIEVE_LIMIT) break;
      out.push(piece);
      size += piece.length;
      if (size > RETRIEVE_LIMIT) break;
    }
    return out.length ? out.join("\n\n") : HANDBOOK_TEXT.slice(0, RETRIEVE_LIMIT);
  }

  // ============================================================
  //  System prompt — the rules the assistant follows
  // ============================================================
  function systemPrompt(handbookText) {
    return [
      `You are the ${HANDBOOK_TITLE} assistant for American University of Sharjah (AUS).`,
      `Your job is to help students and staff understand university policies and procedures.`,
      ``,
      `PERSONALITY`,
      `Be warm, friendly, and genuinely conversational — like a helpful person at the student`,
      `help desk, not a stiff corporate bot. Mirror the user's tone, energy, and language: if`,
      `they're casual or playful (e.g. "hi habibi"), greet them back warmly in the same spirit;`,
      `if they're formal, be professional. Keep greetings and small talk short, natural, and`,
      `human. Do NOT tack on robotic boilerplate like "with the AUS policies and procedures" or`,
      `repeat a canned line every message. You can use light, friendly language and the`,
      `occasional Arabic-English mix if the user does. Stay respectful and never over-do it.`,
      ``,
      `The handbook text (or the most relevant excerpts for this question) is provided below`,
      `between <handbook> tags. Page boundaries are marked with [[PAGE n]]; text after a marker`,
      `is on page n.`,
      ``,
      `RULES`,
      `1. For any question about AUS policy or procedure, answer ONLY using the handbook text below.`,
      `   Do not invent rules, numbers, deadlines, sections, or pages.`,
      `2. Every policy answer MUST cite its source: the section (with number and title if`,
      `   present) and the page number it appears on. Only cite pages that actually contain`,
      `   the information. Never guess a page.`,
      `3. If the answer is not in the text below, say so plainly, suggest the relevant AUS office`,
      `   to contact, set "in_handbook" to false, and give no sources.`,
      `4. You MAY answer ordinary conversational messages, greetings, small talk, and simple`,
      `   general questions or basic math normally and warmly (see PERSONALITY). For these, set`,
      `   "in_handbook" false and give no sources — and keep it friendly and natural, not formal.`,
      `5. Write clearly and be organized: short paragraphs, and numbered or bulleted lists for`,
      `   any step-by-step procedure. Be accurate and neutral; do not add opinions.`,
      `6. Include a diagram ONLY when it genuinely helps — a real hierarchy, reporting line,`,
      `   org structure, or a multi-step process with connected stages. Do NOT make a diagram`,
      `   for simple lists, definitions, aims/objectives, or single-topic answers; leave it empty`,
      `   in those cases. When you do include one, use a Mermaid flowchart:`,
      `   - Begin with "flowchart TD", "flowchart BT" (bottom-up, good for reporting lines that`,
      `     point upward), or "flowchart LR".`,
      `   - Wrap every node label in double quotes, e.g. A["Audit and Compliance Committee (ACC)"].`,
      `   - Use --> for each connection, in the real direction of flow or reporting.`,
      `   - Use ONLY entities named in the handbook text. Never invent nodes or links.`,
      `   - Valid Mermaid only, no code fences, no commentary.`,
      ``,
      `OUTPUT FORMAT — follow this exactly:`,
      `First, write your reply to the user in GitHub-flavored markdown (this is what they read).`,
      `Then output a line containing exactly:`,
      `===META===`,
      `Then, on the next line, ONE minified JSON object and nothing after it:`,
      `{"diagram":"<Mermaid flowchart or empty string>","sources":[{"label":"§6.1 Academic Integrity","page":27}],"in_handbook":true}`,
      `Rules: "sources" is an array (empty when not applicable); "page" is an integer; for a`,
      `Mermaid diagram write newlines as \\n inside the JSON string. Write nothing after the JSON.`,
      ``,
      `<handbook>`,
      handbookText,
      `</handbook>`
    ].join("\n");
  }

  // ============================================================
  //  Gemini API call (streaming) — text streams live; metadata (diagram,
  //  sources) comes after a ===META=== marker at the end.
  // ============================================================
  const META_MARK = "===META===";

  async function askGeminiStream(userText, onAnswer) {
    const key = localStorage.getItem(LS_KEY);
    const model = currentModel();
    if (!key) throw new Error("NO_KEY");

    const contents = history.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }]
    }));

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

    const selectedHandbook = handbookForQuery(userText || "");
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt(selectedHandbook) }] },
      contents,
      generationConfig: { temperature: 0.2 }
    };

    controller = new AbortController();
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (netErr) {
      if (netErr.name === "AbortError") throw new Error("ABORTED");
      throw new Error("NETWORK");
    }

    if (!res.ok) {
      let detail = "";
      try { const e = await res.json(); detail = (e && e.error && e.error.message) || ""; } catch {}
      if (res.status === 429) throw new Error("RATE_LIMIT::" + detail);
      if (res.status === 400 || res.status === 403) throw new Error("BAD_KEY::" + detail);
      throw new Error("HTTP_" + res.status + "::" + detail);
    }

    // Read the SSE stream and accumulate text.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "", full = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = sseBuf.indexOf("\n")) !== -1) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            const piece = (obj.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
            if (piece) {
              full += piece;
              const cut = full.indexOf(META_MARK);
              onAnswer(cut === -1 ? full : full.slice(0, cut));
            }
          } catch { /* ignore keep-alives / partial frames */ }
        }
      }
    } catch (streamErr) {
      if (streamErr.name === "AbortError") throw new Error("ABORTED");
      throw new Error("NETWORK");
    }

    const cut = full.indexOf(META_MARK);
    const answer = (cut === -1 ? full : full.slice(0, cut)).trim();
    const meta = parseMeta(cut === -1 ? "" : full.slice(cut + META_MARK.length));
    return { answer: answer || "Sorry, I couldn't produce an answer. Please try again.", ...meta };
  }

  // Parse the trailing metadata JSON tolerantly.
  function parseMeta(metaStr) {
    const a = metaStr.indexOf("{"), b = metaStr.lastIndexOf("}");
    if (a === -1 || b === -1 || b < a) return { diagram: "", sources: [], inHandbook: false };
    try {
      const o = JSON.parse(metaStr.slice(a, b + 1));
      let diagram = typeof o.diagram === "string" ? o.diagram : "";
      diagram = diagram.replace(/^```(?:mermaid)?/i, "").replace(/```$/i, "").trim();
      return {
        diagram,
        sources: Array.isArray(o.sources) ? o.sources : [],
        inHandbook: !!o.in_handbook
      };
    } catch {
      return { diagram: "", sources: [], inHandbook: false };
    }
  }

  // ============================================================
  //  Send flow
  // ============================================================
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;

    if (!localStorage.getItem(LS_KEY)) {
      openSettings();
      return;
    }

    hideWelcome();
    addMessage({ role: "user", text });
    history.push({ role: "user", text });
    saveHistory();

    input.value = "";
    autosize();
    setBusy(true);
    const live = createLiveBubble();   // shows typing dots, then fills as text streams in

    try {
      const reply = await askGeminiStream(text, partial => live.update(partial));
      live.finalize(reply);
      history.push({ role: "assistant", text: reply.answer });
      saveHistory();
    } catch (err) {
      if (err.message === "ABORTED") {
        live.stopHere();   // keep whatever streamed in so far
      } else {
        live.remove();
        addMessage({ role: "assistant", text: errorMessage(err), error: true });
      }
    } finally {
      controller = null;
      setBusy(false);
      input.focus();
    }
  }

  // A message bubble that starts as a typing indicator and fills in live.
  function createLiveBubble() {
    const wrap = document.createElement("div");
    wrap.className = "msg msg--bot";
    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
    bubble.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
    wrap.appendChild(bubble);
    thread.appendChild(wrap);
    scrollToBottom();

    let hasText = false;
    return {
      update(answer) {
        if (!answer) return;
        hasText = true;
        bubble.innerHTML = renderMarkdown(answer);
        scrollToBottom();
      },
      finalize(reply) {
        bubble.innerHTML = renderMarkdown(reply.answer || "");
        if (reply.diagram && window.mermaid) {
          const box = document.createElement("div");
          box.className = "diagram";
          bubble.appendChild(box);
          renderDiagram(box, reply.diagram);
        }
        if (reply.inHandbook && reply.sources && reply.sources.length) {
          bubble.appendChild(renderSources(reply.sources));
        }
        scrollToBottom();
      },
      stopHere() {
        if (!hasText) wrap.remove();   // nothing streamed yet: drop empty bubble
      },
      remove() { wrap.remove(); }
    };
  }

  function errorMessage(err) {
    const [code, detail] = String(err.message).split("::");
    switch (code) {
      case "NO_KEY":
        return "Add your Gemini API key in **Settings** to start asking questions.";
      case "NETWORK":
        return "Couldn't reach Gemini. This usually means the page was opened directly as a file (the address starts with `file://`), which browsers block from calling Gemini. Run it through a local server or open your GitHub Pages link, then try again. (See the README.)";
      case "RATE_LIMIT":
        return "Gemini's free-tier quota was hit" + (detail ? ` — Google says: “${detail}”` : "") + ". If it clears within a minute it was the per-minute limit. If it keeps happening, it's the **daily** cap (resets after midnight US Pacific time) or the request is too large. Try switching to **Flash-Lite** in Settings, or use a fresh API key.";
      case "BAD_KEY":
        return "Gemini rejected the request" + (detail ? `: ${detail}` : "") + ". Check the key in **Settings** — get a free one at Google AI Studio.";
      default:
        return "Gemini returned an error" + (detail ? `: ${detail}` : ` (${code})`) + ".";
    }
  }

  // ============================================================
  //  Diagram rendering (Mermaid) — turns structures/flows into visuals
  // ============================================================
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        primaryColor: "#F3E7E9",
        primaryBorderColor: "#862633",
        primaryTextColor: "#1F1A1B",
        lineColor: "#862633",
        fontFamily: "Public Sans, system-ui, sans-serif",
        fontSize: "14px"
      },
      flowchart: { htmlLabels: true, curve: "basis", useMaxWidth: true }
    });
  }

  async function renderDiagram(box, code) {
    try {
      const id = "mmd-" + Math.random().toString(36).slice(2);
      const { svg } = await mermaid.render(id, code);
      box.innerHTML = svg;
      scrollToBottom();
    } catch (e) {
      console.warn("Diagram could not be rendered:", e);
      box.remove();   // invalid diagram: drop it, the text answer still stands
    }
  }

  // ============================================================
  //  Rendering
  // ============================================================
  function addMessage({ role, text, sources = [], inHandbook = false, error = false, diagram = "" }) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "msg--user" : "msg--bot") + (error ? " msg--error" : "");

    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
    bubble.innerHTML = renderMarkdown(text);
    wrap.appendChild(bubble);

    if (role === "assistant" && diagram && window.mermaid) {
      const box = document.createElement("div");
      box.className = "diagram";
      bubble.appendChild(box);
      renderDiagram(box, diagram);   // fills in asynchronously
    }

    if (role === "assistant" && inHandbook && sources.length) {
      bubble.appendChild(renderSources(sources));
    }

    thread.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function renderSources(sources) {
    const box = document.createElement("div");
    box.className = "sources";

    const label = document.createElement("p");
    label.className = "sources__label";
    label.textContent = "Sources in the handbook";
    box.appendChild(label);

    const list = document.createElement("div");
    list.className = "sources__list";

    sources.forEach(s => {
      const label = (s.label || "").toString();
      const page = Number.isFinite(+s.page) ? +s.page : null;
      const canLink = HANDBOOK_PDF && page;

      const el = document.createElement(canLink ? "a" : "span");
      el.className = "cite";
      if (canLink) {
        el.href = `${HANDBOOK_PDF}#page=${page}`;
        el.target = "_blank";
        el.rel = "noopener";
      }
      el.innerHTML =
        escapeHtml(label) +
        (page ? ` <span class="cite__page">· p.${page}</span>` : "");
      list.appendChild(el);
    });

    box.appendChild(list);
    return box;
  }

  function addTyping() {
    const wrap = document.createElement("div");
    wrap.className = "msg msg--bot";
    wrap.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
    thread.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  // Minimal, safe markdown -> HTML (escapes first, then formats).
  function renderMarkdown(md) {
    let s = escapeHtml(md || "");

    // inline: bold, italic, code
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    const lines = s.split("\n");
    let html = "", listType = null, buf = [];

    const flushPara = () => {
      if (buf.length) { html += `<p>${buf.join("<br>")}</p>`; buf = []; }
    };
    const closeList = () => {
      if (listType) { html += `</${listType}>`; listType = null; }
    };

    for (const line of lines) {
      const t = line.trim();
      const hd = t.match(/^(#{1,6})\s+(.*)$/);
      const ol = t.match(/^\d+[.)]\s+(.*)$/);
      const ul = t.match(/^[-*]\s+(.*)$/);
      const bq = t.match(/^>\s?(.*)$/);

      if (hd) {
        flushPara(); closeList();
        const level = hd[1].length <= 2 ? 3 : 4;   // #/## -> h3, ###+ -> h4
        html += `<h${level}>${hd[2]}</h${level}>`;
      } else if (ol) {
        flushPara();
        if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
        html += `<li>${ol[1]}</li>`;
      } else if (ul) {
        flushPara();
        if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
        html += `<li>${ul[1]}</li>`;
      } else if (bq) {
        flushPara(); closeList();
        html += `<blockquote>${bq[1]}</blockquote>`;
      } else if (t === "") {
        flushPara(); closeList();
      } else {
        if (listType) closeList();
        buf.push(t);
      }
    }
    flushPara(); closeList();
    return html;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ============================================================
  //  UI helpers
  // ============================================================
  function hideWelcome() { if (welcome) welcome.style.display = "none"; }
  function scrollToBottom() { thread.scrollTop = thread.scrollHeight; }

  function setBusy(v) {
    busy = v;
    input.disabled = v;
    if (micBtn) micBtn.disabled = v;
    sendBtn.classList.toggle("is-stop", v);
    sendBtn.setAttribute("aria-label", v ? "Stop generating" : "Send message");
    sendBtn.innerHTML = v ? STOP_ICON : SEND_ICON;
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  function renderHistory() {
    if (!history.length) return;
    hideWelcome();
    // sources/in_handbook aren't stored across reloads; show past answers as plain text.
    history.forEach(m => addMessage({ role: m.role, text: m.text }));
  }

  // ---- Settings dialog ----
  function openSettings() {
    apiKeyInput.value = localStorage.getItem(LS_KEY) || "";
    modelSelect.value = currentModel();
    overlay.classList.add("is-open");
    apiKeyInput.focus();
  }
  function closeSettings() { overlay.classList.remove("is-open"); }

  // ---- Persistence ----
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_CHAT)) || []; }
    catch { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(LS_CHAT, JSON.stringify(history)); } catch {}
  }

  // ============================================================
  //  Events
  // ============================================================
  form.addEventListener("submit", e => {
    e.preventDefault();
    if (busy) { stop(); return; }   // the send button is a stop button while generating
    send(input.value);
  });

  function stop() { if (controller) controller.abort(); }

  input.addEventListener("input", autosize);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });

  document.getElementById("examples").addEventListener("click", e => {
    const b = e.target.closest(".example");
    if (b) send(b.textContent);
  });

  newChatBtn.addEventListener("click", () => {
    history = [];
    saveHistory();
    thread.querySelectorAll(".msg").forEach(n => n.remove());
    if (welcome) welcome.style.display = "";
    input.focus();
  });

  settingsBtn.addEventListener("click", openSettings);
  settingsCancel.addEventListener("click", closeSettings);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeSettings(); });
  settingsSave.addEventListener("click", () => {
    const k = apiKeyInput.value.trim();
    try {
      if (k) localStorage.setItem(LS_KEY, k); else localStorage.removeItem(LS_KEY);
      localStorage.setItem(LS_MODEL, modelSelect.value);
    } catch (e) {
      alert("Couldn't save settings in this browser. If you opened the page as a file, run it on a local server or your GitHub Pages link instead.");
    }
    closeSettings();   // always close, even if storage failed
    input.focus();
  });

  // ---- Voice input (Web Speech API) ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, listening = false, voiceBase = "";
  if (SR && micBtn) {
    micBtn.style.display = "inline-flex";   // reveal only when the browser supports it
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.addEventListener("result", e => {
      let transcript = "";
      for (let i = e.resultIndex; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      input.value = (voiceBase ? voiceBase + " " : "") + transcript.trim();
      autosize();
    });
    const endListening = () => { listening = false; micBtn.classList.remove("is-listening"); };
    recognition.addEventListener("end", () => { endListening(); input.focus(); });
    recognition.addEventListener("error", endListening);

    micBtn.addEventListener("click", () => {
      if (busy) return;
      if (listening) { recognition.stop(); return; }
      voiceBase = input.value.trim();
      try {
        recognition.start();
        listening = true;
        micBtn.classList.add("is-listening");
      } catch (_) { /* start() throws if already running — ignore */ }
    });
  }

  // ============================================================
  //  Init
  // ============================================================
  renderHistory();
  autosize();

  if (location.protocol === "file:") {
    // Opened by double-clicking the file — Gemini calls will be blocked.
    hideWelcome();
    addMessage({
      role: "assistant",
      error: true,
      text: "This page is open directly from a file (`file://`), so the browser will block calls to Gemini. Start it with a local server — for example run `python3 -m http.server 8000` in this folder and open http://localhost:8000 — or just open your GitHub Pages link. See the README for steps."
    });
  }

  if (!localStorage.getItem(LS_KEY)) openSettings();
})();
