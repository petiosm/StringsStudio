import { useState, useCallback, useRef, useEffect } from "react";

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseStringsXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("Invalid XML file");

  const entries = [];

  doc.querySelectorAll("string").forEach((el) => {
    const name = el.getAttribute("name");
    if (name) entries.push({ type: "string", name, value: el.textContent, translated: "" });
  });

  doc.querySelectorAll("string-array").forEach((el) => {
    const name = el.getAttribute("name");
    el.querySelectorAll("item").forEach((item, i) => {
      entries.push({ type: "string-array", name: `${name}[${i}]`, value: item.textContent, translated: "" });
    });
  });

  doc.querySelectorAll("plurals").forEach((el) => {
    const name = el.getAttribute("name");
    el.querySelectorAll("item").forEach((item) => {
      const qty = item.getAttribute("quantity") || "other";
      entries.push({ type: "plurals", name: `${name}[${qty}]`, value: item.textContent, translated: "" });
    });
  });

  return entries;
}

function buildTranslatedXml(entries, targetLang) {
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<!-- Translated to: ${targetLang} -->`,
    `<resources>`,
  ];

  entries.forEach((e) => {
    const val = (e.translated || e.value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (e.type === "string") {
      lines.push(`    <string name="${e.name}">${val}</string>`);
    }
  });

  const arrayGroups = {};
  const pluralGroups = {};
  entries.forEach((e) => {
    if (e.type === "string-array") {
      const base = e.name.replace(/\[\d+\]$/, "");
      if (!arrayGroups[base]) arrayGroups[base] = [];
      arrayGroups[base].push(e);
    }
    if (e.type === "plurals") {
      const base = e.name.replace(/\[.*?\]$/, "");
      if (!pluralGroups[base]) pluralGroups[base] = [];
      pluralGroups[base].push(e);
    }
  });

  Object.entries(arrayGroups).forEach(([name, items]) => {
    lines.push(`    <string-array name="${name}">`);
    items.forEach((i) => {
      const v = (i.translated || i.value).replace(/&/g, "&amp;");
      lines.push(`        <item>${v}</item>`);
    });
    lines.push(`    </string-array>`);
  });

  Object.entries(pluralGroups).forEach(([name, items]) => {
    lines.push(`    <plurals name="${name}">`);
    items.forEach((i) => {
      const qty = i.name.match(/\[(.+)\]$/)?.[1] || "other";
      const v = (i.translated || i.value).replace(/&/g, "&amp;");
      lines.push(`        <item quantity="${qty}">${v}</item>`);
    });
    lines.push(`    </plurals>`);
  });

  lines.push(`</resources>`);
  return lines.join("\n");
}

const LANGUAGES = [
  "Arabic", "Bengali", "Chinese (Simplified)", "Chinese (Traditional)",
  "Czech", "Danish", "Dutch", "Finnish", "French", "German",
  "Greek", "Hebrew", "Hindi", "Hungarian", "Indonesian",
  "Italian", "Japanese", "Korean", "Malay", "Norwegian",
  "Persian", "Polish", "Portuguese (Brazil)", "Portuguese (Portugal)",
  "Romanian", "Russian", "Spanish", "Swedish", "Thai",
  "Turkish", "Ukrainian", "Urdu", "Vietnamese",
];

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Google Gemini" },
];

const MODELS = {
  anthropic: [
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "custom", label: "Custom model…" },
  ],
  gemini: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { id: "gemini-2.5-pro-preview-05-06", label: "Gemini 2.5 Pro" },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    { id: "custom", label: "Custom model…" },
  ],
};

// ── LocalStorage ──────────────────────────────────────────────────────────────

function lsGet(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// ── AI Translation ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = (lang) =>
  `You are a professional Android app localizer. Translate the Android strings.xml values to ${lang}.
Rules:
- Preserve %s, %d, %1$s, %2$d placeholders exactly as-is
- Preserve HTML tags like <b>, <i>, <br/>
- Keep the same numbered format: "1. [key]: translation"
- Translate ONLY the value part after the colon
- Output ONLY the numbered list, nothing else`;

function parseTranslationResponse(text) {
  const results = {};
  text.split("\n").forEach((line) => {
    const m = line.match(/^\d+\.\s*\[(.+?)\]:\s*(.+)/);
    if (m) results[m[1]] = m[2].trim();
  });
  return results;
}

async function translateBatchAnthropic(strings, targetLang, model, apiKey, signal) {
  const payload = strings.map((s, i) => `${i + 1}. [${s.name}]: ${s.value}`).join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT(targetLang),
      messages: [{ role: "user", content: `Translate these strings to ${targetLang}:\n\n${payload}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}`);
  const data = await res.json();
  return parseTranslationResponse(data.content?.[0]?.text || "");
}

async function translateBatchGemini(strings, targetLang, model, apiKey, signal) {
  const payload = strings.map((s, i) => `${i + 1}. [${s.name}]: ${s.value}`).join("\n");
  const prompt = `${SYSTEM_PROMPT(targetLang)}\n\nTranslate these strings to ${targetLang}:\n\n${payload}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
  const data = await res.json();
  return parseTranslationResponse(data.candidates?.[0]?.content?.parts?.[0]?.text || "");
}

async function translateBatch(strings, targetLang, provider, model, apiKey, signal) {
  if (provider === "anthropic") return translateBatchAnthropic(strings, targetLang, model, apiKey, signal);
  if (provider === "gemini") return translateBatchGemini(strings, targetLang, model, apiKey, signal);
  throw new Error("Unknown provider");
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

// ── App ───────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 20;

export default function App() {
  const isMobile = useIsMobile();

  const [entries, setEntries] = useState([]);
  const [fileName, setFileName] = useState("");
  const [targetLang, setTargetLang] = useState(() => lsGet("ss_lang", "Spanish"));

  const [provider, setProvider] = useState(() => lsGet("ss_provider", "anthropic"));
  const [anthropicModel, setAnthropicModel] = useState(() => lsGet("ss_model_anthropic", "claude-sonnet-4-20250514"));
  const [geminiModel, setGeminiModel] = useState(() => lsGet("ss_model_gemini", "gemini-2.0-flash"));
  const [anthropicCustomModel, setAnthropicCustomModel] = useState(() => lsGet("ss_custom_anthropic", ""));
  const [geminiCustomModel, setGeminiCustomModel] = useState(() => lsGet("ss_custom_gemini", ""));
  const [anthropicKey, setAnthropicKey] = useState(() => lsGet("ss_key_anthropic", ""));
  const [geminiKey, setGeminiKey] = useState(() => lsGet("ss_key_gemini", ""));
  const [showKey, setShowKey] = useState(false);

  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [tab, setTab] = useState("all");
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);

  const currentModel = provider === "anthropic" ? anthropicModel : geminiModel;
  const currentCustomModel = provider === "anthropic" ? anthropicCustomModel : geminiCustomModel;
  const activeModel = currentModel === "custom" ? currentCustomModel : currentModel;
  const activeKey = provider === "anthropic" ? anthropicKey : geminiKey;
  const currentModels = MODELS[provider];

  useEffect(() => { lsSet("ss_lang", targetLang); }, [targetLang]);
  useEffect(() => { lsSet("ss_provider", provider); }, [provider]);
  useEffect(() => { lsSet("ss_model_anthropic", anthropicModel); }, [anthropicModel]);
  useEffect(() => { lsSet("ss_model_gemini", geminiModel); }, [geminiModel]);
  useEffect(() => { lsSet("ss_custom_anthropic", anthropicCustomModel); }, [anthropicCustomModel]);
  useEffect(() => { lsSet("ss_custom_gemini", geminiCustomModel); }, [geminiCustomModel]);
  useEffect(() => { lsSet("ss_key_anthropic", anthropicKey); }, [anthropicKey]);
  useEffect(() => { lsSet("ss_key_gemini", geminiKey); }, [geminiKey]);

  const setCurrentModel = (val) => {
    if (provider === "anthropic") setAnthropicModel(val);
    else setGeminiModel(val);
  };

  const setCurrentCustomModel = (val) => {
    if (provider === "anthropic") setAnthropicCustomModel(val);
    else setGeminiCustomModel(val);
  };

  const setActiveKey = (val) => {
    if (provider === "anthropic") setAnthropicKey(val);
    else setGeminiKey(val);
  };

  const loadFile = useCallback((file) => {
    if (!file) return;
    setError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseStringsXml(e.target.result);
        setEntries(parsed);
        setFileName(file.name);
        setProgress(null);
      } catch (err) {
        setError("Could not parse XML: " + err.message);
      }
    };
    reader.readAsText(file);
  }, []);

  const onFileChange = (e) => loadFile(e.target.files[0]);
  const onDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    loadFile(e.dataTransfer.files[0]);
  };

  const updateTranslation = (idx, value) => {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, translated: value } : e)));
  };

  const doTranslateAll = async () => {
    if (!entries.length) return;
    if (!activeKey.trim()) { setError("Please enter your API key to use AI translation."); return; }
    if (!activeModel.trim()) { setError("Please enter a model name."); return; }
    setError("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const untranslated = entries.filter((e) => !e.translated);
    setProgress({ done: 0, total: untranslated.length });

    let done = 0;
    for (let i = 0; i < untranslated.length; i += BATCH_SIZE) {
      if (ctrl.signal.aborted) break;
      const batch = untranslated.slice(i, i + BATCH_SIZE);
      try {
        const results = await translateBatch(batch, targetLang, provider, activeModel, activeKey.trim(), ctrl.signal);
        setEntries((prev) =>
          prev.map((e) => (results[e.name] ? { ...e, translated: results[e.name] } : e))
        );
        done += batch.length;
        setProgress({ done, total: untranslated.length });
      } catch (err) {
        if (err.name !== "AbortError") setError("Translation error: " + err.message);
        break;
      }
    }
    setProgress(null);
    abortRef.current = null;
  };

  const cancelTranslation = () => {
    abortRef.current?.abort();
    setProgress(null);
  };

  const downloadXml = () => {
    const xml = buildTranslatedXml(entries, targetLang);
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `strings_${targetLang.toLowerCase().replace(/\s+/g, "_")}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredEntries = entries
    .map((e, i) => ({ ...e, _idx: i }))
    .filter((e) => {
      if (tab === "untranslated" && e.translated) return false;
      if (tab === "translated" && !e.translated) return false;
      if (search) {
        const q = search.toLowerCase();
        return e.name.toLowerCase().includes(q) || e.value.toLowerCase().includes(q);
      }
      return true;
    });

  const translatedCount = entries.filter((e) => e.translated).length;
  const pct = entries.length ? Math.round((translatedCount / entries.length) * 100) : 0;

  const typeBadgeLabel = (type) =>
    type === "string" ? "str" : type === "string-array" ? "arr" : "plu";

  return (
    <div style={styles.root}>
      <div style={styles.bgGrid} />

      {/* Header */}
      <header style={styles.header}>
        <div style={{ ...styles.headerInner, padding: isMobile ? "10px 16px" : "12px 24px" }}>
          <div style={styles.logoGroup}>
            <div style={styles.logoIcon}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M4 5h16M4 10h10M4 15h12M4 20h8" stroke="#f97316" strokeWidth="2" strokeLinecap="round" />
                <circle cx="19" cy="17" r="4" stroke="#f97316" strokeWidth="1.5" />
                <path d="M17 17l1.5 1.5L21 15" stroke="#f97316" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div style={styles.logoTitle}>StringsStudio</div>
              {!isMobile && <div style={styles.logoSub}>Android · XML Translator</div>}
            </div>
          </div>

          {entries.length > 0 && (
            <div style={styles.headerStats}>
              <div style={styles.statPill}>
                <span style={{ color: "#f97316", fontWeight: 700 }}>{translatedCount}</span>
                <span style={{ color: "#94a3b8" }}>/{entries.length}</span>
                <span style={{ color: "#64748b", marginLeft: 4, fontSize: 11 }}>translated</span>
              </div>
              {!isMobile && (
                <div style={styles.progressBarSmall}>
                  <div style={{ ...styles.progressFill, width: `${pct}%` }} />
                </div>
              )}
              <span style={{ color: "#f97316", fontWeight: 700, fontSize: 13 }}>{pct}%</span>
            </div>
          )}
        </div>
      </header>

      <main style={{ ...styles.main, padding: isMobile ? "16px 12px" : "32px 24px" }}>
        {!entries.length ? (
          <div style={styles.uploadSection}>
            <div
              style={{
                ...styles.dropZone,
                ...(isDragging ? styles.dropZoneActive : {}),
                padding: isMobile ? "40px 20px" : "60px 40px",
              }}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input ref={fileInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={onFileChange} />
              <div style={styles.dropIcon}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="#f97316" strokeWidth="1.5" />
                  <polyline points="14 2 14 8 20 8" stroke="#f97316" strokeWidth="1.5" />
                  <line x1="12" y1="18" x2="12" y2="12" stroke="#f97316" strokeWidth="1.5" strokeLinecap="round" />
                  <polyline points="9 15 12 12 15 15" stroke="#f97316" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <div style={styles.dropTitle}>Drop your strings.xml here</div>
              <div style={styles.dropSub}>
                {isMobile ? "Tap to browse" : "or click to browse"} · supports &lt;string&gt;, &lt;string-array&gt;, &lt;plurals&gt;
              </div>
            </div>
            {error && <div style={styles.errorBox}>{error}</div>}
          </div>
        ) : (
          <>
            {/* Settings bar */}
            <div style={{ ...styles.settingsBar, flexDirection: isMobile ? "column" : "row" }}>
              <div style={styles.settingsGroup}>
                <span style={styles.settingsLabel}>Provider</span>
                <select
                  style={styles.settingsSelect}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  disabled={!!progress}
                >
                  {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>

              <div style={{ ...styles.settingsGroup, flexWrap: "wrap" }}>
                <span style={styles.settingsLabel}>Model</span>
                <select
                  style={styles.settingsSelect}
                  value={currentModel}
                  onChange={(e) => setCurrentModel(e.target.value)}
                  disabled={!!progress}
                >
                  {currentModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                {currentModel === "custom" && (
                  <input
                    style={{ ...styles.apiKeyInput, width: isMobile ? "100%" : 180, flex: "none" }}
                    type="text"
                    placeholder="Enter model name…"
                    value={currentCustomModel}
                    onChange={(e) => setCurrentCustomModel(e.target.value)}
                  />
                )}
              </div>

              <div style={{ ...styles.settingsGroup, flex: 1 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span style={styles.settingsLabel}>
                  {provider === "anthropic" ? "Anthropic" : "Gemini"} Key
                </span>
                <input
                  style={{ ...styles.apiKeyInput, flex: 1 }}
                  type={showKey ? "text" : "password"}
                  placeholder={provider === "anthropic" ? "sk-ant-… (leave empty for manual)" : "AIza… (leave empty for manual)"}
                  value={activeKey}
                  onChange={(e) => setActiveKey(e.target.value)}
                />
                <button style={styles.btnGhost} onClick={() => setShowKey((v) => !v)}>
                  {showKey ? "Hide" : "Show"}
                </button>
                {activeKey && <span style={styles.keyOkBadge}>✓ set</span>}
              </div>
            </div>

            {/* Toolbar */}
            <div style={{ ...styles.toolbar, flexDirection: isMobile ? "column" : "row" }}>
              <div style={{ ...styles.toolbarLeft, flexWrap: "wrap" }}>
                <div style={styles.fileChip}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="#f97316" strokeWidth="2" />
                    <polyline points="14 2 14 8 20 8" stroke="#f97316" strokeWidth="2" />
                  </svg>
                  {fileName}
                </div>
                <select
                  style={styles.langSelect}
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  disabled={!!progress}
                >
                  {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>

              <div style={{ ...styles.toolbarRight, flexWrap: "wrap" }}>
                <button
                  style={{ ...styles.btnGhost, flex: isMobile ? 1 : "none" }}
                  onClick={() => { setEntries([]); setFileName(""); }}
                >
                  Load new file
                </button>
                {progress ? (
                  <button
                    style={{ ...styles.btnDanger, flex: isMobile ? 1 : "none" }}
                    onClick={cancelTranslation}
                  >
                    ✕ Cancel ({progress.done}/{progress.total})
                  </button>
                ) : (
                  <button
                    style={{ ...styles.btnPrimary, flex: isMobile ? 1 : "none", justifyContent: "center" }}
                    onClick={doTranslateAll}
                    disabled={!entries.length}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: 6 }}>
                      <path d="M12 2a10 10 0 1 0 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      <path d="M18 2l4 4-4 4M22 6H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    AI Translate All
                  </button>
                )}
                <button
                  style={{ ...styles.btnAccent, opacity: entries.length === 0 ? 0.4 : 1, flex: isMobile ? 1 : "none" }}
                  onClick={downloadXml}
                  disabled={entries.length === 0}
                >
                  ↓ Download XML
                </button>
              </div>
            </div>

            {/* Progress */}
            {progress && (
              <div style={styles.progressRow}>
                <div style={styles.progressTrack}>
                  <div
                    style={{
                      ...styles.progressFill,
                      width: `${Math.round((progress.done / progress.total) * 100)}%`,
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
                <span style={{ color: "#f97316", fontSize: 12, whiteSpace: "nowrap" }}>
                  Translating {progress.done}/{progress.total}…
                </span>
              </div>
            )}

            {error && <div style={styles.errorBox}>{error}</div>}

            {/* Filters */}
            <div style={{ ...styles.filterRow, flexDirection: isMobile ? "column" : "row" }}>
              <div style={{ ...styles.tabs, flex: isMobile ? 1 : "none" }}>
                {["all", "untranslated", "translated"].map((t) => (
                  <button
                    key={t}
                    style={{ ...styles.tabBtn, ...(tab === t ? styles.tabActive : {}), flex: isMobile ? 1 : "none" }}
                    onClick={() => setTab(t)}
                  >
                    {t === "all" && `All (${entries.length})`}
                    {t === "untranslated" && `Pending (${entries.length - translatedCount})`}
                    {t === "translated" && `Done (${translatedCount})`}
                  </button>
                ))}
              </div>
              <input
                style={{ ...styles.searchInput, width: isMobile ? "100%" : 220 }}
                placeholder="Search keys or values…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* Table */}
            <div style={styles.tableWrap}>
              {!isMobile && (
                <div style={styles.tableHeader}>
                  <div style={{ ...styles.col, flex: "0 0 220px", color: "#f97316" }}>Key</div>
                  <div style={{ ...styles.col, flex: 1 }}>Original</div>
                  <div style={{ ...styles.col, flex: 1, color: "#34d399" }}>
                    {targetLang} Translation
                  </div>
                </div>
              )}

              <div style={{ ...styles.tableBody, maxHeight: isMobile ? "65vh" : "60vh" }}>
                {filteredEntries.length === 0 ? (
                  <div style={styles.emptyState}>No strings match your filter.</div>
                ) : isMobile ? (
                  filteredEntries.map((e) => (
                    <div key={e._idx} style={{ ...styles.mobileCard, ...(e.translated ? styles.rowDone : {}) }}>
                      <div style={styles.mobileCardTop}>
                        <span style={styles.keyBadge}>{typeBadgeLabel(e.type)}</span>
                        <span style={{ ...styles.keyName, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {e.name}
                        </span>
                        {e.translated && <span style={{ fontSize: 11, color: "#34d399", flexShrink: 0 }}>✓</span>}
                      </div>
                      <div style={styles.mobileOriginal}>{e.value}</div>
                      <textarea
                        style={{ ...styles.transInput, ...(e.translated ? styles.transInputDone : {}), resize: "vertical", minHeight: 60, width: "100%" }}
                        value={e.translated}
                        onChange={(ev) => updateTranslation(e._idx, ev.target.value)}
                        placeholder="Type translation here…"
                        rows={2}
                      />
                    </div>
                  ))
                ) : (
                  filteredEntries.map((e) => (
                    <div key={e._idx} style={{ ...styles.tableRow, ...(e.translated ? styles.rowDone : {}) }}>
                      <div style={{ ...styles.col, flex: "0 0 220px" }}>
                        <span style={styles.keyBadge}>{typeBadgeLabel(e.type)}</span>
                        <span style={styles.keyName}>{e.name}</span>
                      </div>
                      <div style={{ ...styles.col, flex: 1 }}>
                        <span style={styles.originalText}>{e.value}</span>
                      </div>
                      <div style={{ ...styles.col, flex: 1 }}>
                        <textarea
                          style={{ ...styles.transInput, ...(e.translated ? styles.transInputDone : {}), resize: "vertical", minHeight: 36 }}
                          value={e.translated}
                          onChange={(ev) => updateTranslation(e._idx, ev.target.value)}
                          placeholder="Type translation here…"
                          rows={1}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  root: {
    minHeight: "100vh",
    background: "#0a0f1a",
    fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
    color: "#e2e8f0",
    position: "relative",
  },
  bgGrid: {
    position: "fixed",
    inset: 0,
    backgroundImage: `linear-gradient(rgba(249,115,22,0.04) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(249,115,22,0.04) 1px, transparent 1px)`,
    backgroundSize: "40px 40px",
    pointerEvents: "none",
    zIndex: 0,
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 100,
    background: "rgba(10,15,26,0.9)",
    backdropFilter: "blur(12px)",
    borderBottom: "1px solid rgba(249,115,22,0.15)",
  },
  headerInner: {
    maxWidth: 1200,
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  logoGroup: { display: "flex", alignItems: "center", gap: 12 },
  logoIcon: {
    width: 40, height: 40,
    borderRadius: 10,
    background: "rgba(249,115,22,0.1)",
    border: "1px solid rgba(249,115,22,0.25)",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  logoTitle: { fontWeight: 700, fontSize: 16, letterSpacing: "-0.3px", color: "#f1f5f9" },
  logoSub: { fontSize: 11, color: "#64748b", letterSpacing: "0.5px", textTransform: "uppercase" },
  headerStats: { display: "flex", alignItems: "center", gap: 10 },
  statPill: {
    background: "rgba(249,115,22,0.08)",
    border: "1px solid rgba(249,115,22,0.2)",
    borderRadius: 20,
    padding: "4px 12px",
    fontSize: 13,
    display: "flex", alignItems: "center", gap: 2,
  },
  progressBarSmall: {
    width: 80, height: 4,
    background: "rgba(255,255,255,0.08)",
    borderRadius: 2,
    overflow: "hidden",
  },
  main: {
    position: "relative",
    zIndex: 1,
    maxWidth: 1200,
    margin: "0 auto",
  },
  uploadSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "60vh",
    gap: 16,
  },
  dropZone: {
    width: "100%",
    maxWidth: 520,
    border: "2px dashed rgba(249,115,22,0.3)",
    borderRadius: 20,
    textAlign: "center",
    cursor: "pointer",
    background: "rgba(249,115,22,0.03)",
    transition: "all 0.2s",
  },
  dropZoneActive: {
    border: "2px dashed #f97316",
    background: "rgba(249,115,22,0.08)",
    transform: "scale(1.02)",
  },
  dropIcon: { marginBottom: 20, opacity: 0.9 },
  dropTitle: { fontSize: 18, fontWeight: 600, color: "#f1f5f9", marginBottom: 8 },
  dropSub: { fontSize: 13, color: "#64748b", lineHeight: 1.6 },
  settingsBar: {
    display: "flex",
    gap: 10,
    background: "rgba(255,255,255,0.02)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 10,
    padding: "10px 14px",
    marginBottom: 12,
    flexWrap: "wrap",
  },
  settingsGroup: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  settingsLabel: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  settingsSelect: {
    background: "#0f172a",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 7,
    color: "#e2e8f0",
    padding: "5px 10px",
    fontSize: 12,
    cursor: "pointer",
    outline: "none",
  },
  apiKeyInput: {
    background: "#0f172a",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 6,
    color: "#e2e8f0",
    padding: "5px 10px",
    fontSize: 12,
    fontFamily: "monospace",
    outline: "none",
    minWidth: 0,
  },
  keyOkBadge: {
    background: "rgba(52,211,153,0.12)",
    border: "1px solid rgba(52,211,153,0.25)",
    color: "#34d399",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 700,
    flexShrink: 0,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 16,
  },
  toolbarLeft: { display: "flex", alignItems: "center", gap: 10 },
  toolbarRight: { display: "flex", alignItems: "center", gap: 8 },
  fileChip: {
    display: "flex", alignItems: "center", gap: 6,
    background: "rgba(249,115,22,0.08)",
    border: "1px solid rgba(249,115,22,0.2)",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    color: "#fbd38d",
    fontFamily: "monospace",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 200,
  },
  langSelect: {
    background: "#0f172a",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    color: "#e2e8f0",
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
    outline: "none",
  },
  btnGhost: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#94a3b8",
    borderRadius: 8,
    padding: "7px 14px",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnPrimary: {
    background: "rgba(249,115,22,0.15)",
    border: "1px solid rgba(249,115,22,0.4)",
    color: "#fb923c",
    borderRadius: 8,
    padding: "7px 16px",
    fontSize: 13,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  btnAccent: {
    background: "linear-gradient(135deg, #f97316, #ea580c)",
    border: "none",
    color: "#fff",
    borderRadius: 8,
    padding: "7px 16px",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  btnDanger: {
    background: "rgba(239,68,68,0.15)",
    border: "1px solid rgba(239,68,68,0.35)",
    color: "#f87171",
    borderRadius: 8,
    padding: "7px 14px",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  progressRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    background: "rgba(255,255,255,0.06)",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #f97316, #fbbf24)",
    borderRadius: 2,
  },
  errorBox: {
    background: "rgba(239,68,68,0.1)",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: 8,
    padding: "10px 16px",
    color: "#fca5a5",
    fontSize: 13,
    marginBottom: 12,
  },
  filterRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
  },
  tabs: { display: "flex", gap: 4 },
  tabBtn: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8,
    color: "#64748b",
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  tabActive: {
    background: "rgba(249,115,22,0.12)",
    border: "1px solid rgba(249,115,22,0.3)",
    color: "#fb923c",
  },
  searchInput: {
    background: "#0f172a",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8,
    color: "#e2e8f0",
    padding: "6px 12px",
    fontSize: 13,
    outline: "none",
    minWidth: 0,
  },
  tableWrap: {
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 12,
    overflow: "hidden",
  },
  tableHeader: {
    display: "flex",
    background: "#0f172a",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    padding: "10px 16px",
    gap: 12,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.8px",
    color: "#475569",
  },
  tableBody: { overflowY: "auto" },
  tableRow: {
    display: "flex",
    alignItems: "center",
    padding: "10px 16px",
    gap: 12,
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    transition: "background 0.15s",
  },
  rowDone: { background: "rgba(52,211,153,0.03)" },
  col: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  keyBadge: {
    flexShrink: 0,
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    background: "rgba(249,115,22,0.12)",
    color: "#f97316",
    borderRadius: 4,
    padding: "2px 5px",
  },
  keyName: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#93c5fd",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  originalText: {
    fontSize: 13,
    color: "#94a3b8",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  transInput: {
    width: "100%",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 6,
    color: "#e2e8f0",
    padding: "6px 10px",
    fontSize: 13,
    outline: "none",
    transition: "border-color 0.2s",
    fontFamily: "inherit",
  },
  transInputDone: {
    borderColor: "rgba(52,211,153,0.3)",
    background: "rgba(52,211,153,0.04)",
    color: "#6ee7b7",
  },
  emptyState: {
    padding: "40px 0",
    textAlign: "center",
    color: "#475569",
    fontSize: 14,
  },
  mobileCard: {
    padding: "12px",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  mobileCardTop: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  mobileOriginal: {
    fontSize: 13,
    color: "#94a3b8",
    lineHeight: 1.5,
  },
};
