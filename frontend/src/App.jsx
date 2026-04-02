import { useState, useRef, useEffect, useCallback } from 'react'

const API = 'http://localhost:8000'

const STATUS_LABELS = {
  uploading: 'Uploading…',
  queued: 'Queued…',
  parsing: 'Parsing book…',
  text_preview: 'Review & edit text',
  scanning: 'Scanning for unfamiliar words…',
  awaiting_review: 'Review phonetics',
  converting: 'Converting to speech…',
  done: 'Done',
  error: 'Error',
}

export default function App() {
  const [file, setFile] = useState(null)
  const [jobId, setJobId] = useState(null)
  const [jobStatus, setJobStatus] = useState(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [voice, setVoice] = useState('af_heart')
  const [engine, setEngine] = useState('kokoro')

  // Text preview state
  const [chapters, setChapters] = useState([])          // [{title, text}]
  const [editedText, setEditedText] = useState('')       // full joined text (editable)
  const [fileType, setFileType] = useState('txt')
  const [perChapter, setPerChapter] = useState(true)

  // Scan method
  const [scanMethod, setScanMethod] = useState('regex')
  const [scanUnknown, setScanUnknown] = useState(false)

  // Phonetics review state
  const [words, setWords] = useState([])
  const [playingWord, setPlayingWord] = useState(null)
  const [phoneticSources, setPhoneticSources] = useState({})      // word -> "lexicon"|"llm"
  const [phoneticAlternatives, setPhoneticAlternatives] = useState({})  // word -> {voice: phonetic}
  const [draftSavedAt, setDraftSavedAt] = useState(null)          // Date of last draft save

  // Output info
  const [outputType, setOutputType] = useState('zip')
  const [outputIsChapters, setOutputIsChapters] = useState(false)

  const pollRef = useRef(null)
  const inputRef = useRef(null)
  const audioRef = useRef(null)
  const previewQueueRef = useRef([])   // pending { text } items
  const previewBusyRef = useRef(false) // true while fetch+playback is in progress

  function pickFile(f) {
    if (!f) return
    const ext = f.name.split('.').pop().toLowerCase()
    if (!['epub', 'txt'].includes(ext)) {
      setError('Only .epub and .txt files are supported.')
      return
    }
    setError(null)
    setFile(f)
    setJobId(null)
    setJobStatus(null)
    setProgress(0)
    setChapters([])
    setEditedText('')
    setWords([])
  }

  const fetchText = useCallback(async (id) => {
    try {
      const res = await fetch(`${API}/text/${id}`)
      if (!res.ok) return
      const data = await res.json()
      setChapters(data.chapters ?? [])
      setEditedText((data.chapters ?? []).map(c => c.text).join('\n\n'))
      setFileType(data.file_type ?? 'txt')
    } catch {
      // ignore
    }
  }, [])

  function startPolling(id) {
    clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/status/${id}`)
        const data = await res.json()
        setJobStatus(data.status)
        setProgress(data.progress ?? 0)

        if (data.status === 'text_preview') {
          clearInterval(pollRef.current)
          fetchText(id)
        }

        if (data.status === 'awaiting_review') {
          clearInterval(pollRef.current)
          const allWords = data.words ?? []
          const phoneticsMap = data.phonetics ?? {}
          const sourcesMap = data.phonetic_sources ?? {}
          const altMap = data.phonetic_alternatives ?? {}
          setPhoneticSources(sourcesMap)
          setPhoneticAlternatives(altMap)
          setWords(allWords.map(({ word, count }) => ({ original: word, phonetic: phoneticsMap[word] ?? '', initialPhonetic: phoneticsMap[word] ?? '', count })))
        }

        if (data.status === 'done') {
          clearInterval(pollRef.current)
          setOutputType(data.output_type ?? 'zip')
          setOutputIsChapters(!!data.per_chapter)
        }

        if (data.status === 'error') {
          clearInterval(pollRef.current)
          if (data.error) setError(data.error)
        }
      } catch {
        // network blip — keep polling
      }
    }, 1500)
  }

  async function handleUpload() {
    if (!file) return
    setError(null)
    setJobStatus('uploading')

    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(
        `${API}/upload?voice=${encodeURIComponent(voice)}&engine=${engine}`,
        { method: 'POST', body: form }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Upload failed')
      setJobId(data.job_id)
      setJobStatus('queued')
      startPolling(data.job_id)
    } catch (e) {
      setError(e.message)
      setJobStatus(null)
    }
  }

  // ── Text preview actions ──────────────────────────────────────────────────

  // True when the textarea still matches the joined chapter texts (no manual edits)
  function chaptersInSync(text, chaps) {
    return text === chaps.map(c => c.text).join('\n\n')
  }

  function applyStripUnusual() {
    // Keep ASCII printable (0x20–0x7E) plus newline, carriage return, tab
    const strip = t => t.replace(/[^\x20-\x7E\n\r\t]/g, '')
    setEditedText(prev => strip(prev))
    setChapters(prev => prev.map(c => ({ ...c, text: strip(c.text) })))
  }

  function applyStripQuotes() {
    // Remove both ASCII and typographic quote characters
    const strip = t => t.replace(/['"'""\u2018\u2019\u201c\u201d\u201e\u201f\u2039\u203a\u00ab\u00bb]/g, '')
    setEditedText(prev => strip(prev))
    setChapters(prev => prev.map(c => ({ ...c, text: strip(c.text) })))
  }

  function deleteChapter(idx) {
    const newChapters = chapters.filter((_, i) => i !== idx)
    setChapters(newChapters)
    setEditedText(newChapters.map(c => c.text).join('\n\n'))
  }

  async function proceedToScan() {
    const inSync = chaptersInSync(editedText, chapters)
    // If user manually edited the textarea, send as a single chapter
    const chapsToSend = inSync && chapters.length > 0
      ? chapters
      : [{ title: 'Full Text', text: editedText }]
    const usePerChapter = inSync && perChapter && fileType === 'epub'

    try {
      const res = await fetch(`${API}/scan/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapters: chapsToSend, per_chapter: usePerChapter, scan_method: scanMethod, scan_unknown: scanUnknown }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail ?? 'Failed to start scan')
      }
      setJobStatus('scanning')
      setProgress(0)
      startPolling(jobId)
    } catch (e) {
      setError(e.message)
    }
  }

  async function proceedToConvert() {
    const inSync = chaptersInSync(editedText, chapters)
    const chapsToSend = inSync && chapters.length > 0
      ? chapters
      : [{ title: 'Full Text', text: editedText }]
    const usePerChapter = inSync && perChapter && fileType === 'epub'

    try {
      const res = await fetch(`${API}/convert/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapters: chapsToSend, per_chapter: usePerChapter }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail ?? 'Failed to start conversion')
      }
      setJobStatus('converting')
      setProgress(0)
      startPolling(jobId)
    } catch (e) {
      setError(e.message)
    }
  }

  // ── Phonetics review actions ──────────────────────────────────────────────

  function updatePhonetic(idx, value) {
    setWords(prev => prev.map((w, i) => i === idx ? { ...w, phonetic: value } : w))
  }

  function removeWord(idx) {
    setWords(prev => prev.filter((_, i) => i !== idx))
  }

  function addWord(word) {
    const w = word.trim()
    if (!w) return
    setWords(prev => {
      if (prev.some(x => x.original.toLowerCase() === w.toLowerCase())) return prev
      return [...prev, { original: w, phonetic: '', count: 1 }]
    })
  }

  async function _runPreview(text) {
    setPlayingWord(text)
    try {
      const res = await fetch(`${API}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, engine }),
      })
      if (!res.ok) throw new Error('Preview generation failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      await new Promise((resolve) => {
        if (audioRef.current) {
          audioRef.current.pause()
          URL.revokeObjectURL(audioRef.current.src)
        }
        const audio = new Audio(url)
        audioRef.current = audio
        audio.onended = resolve
        audio.onerror = resolve
        audio.play()
      })
    } catch (e) {
      setError(e.message)
    }
    setPlayingWord(null)
    const next = previewQueueRef.current.shift()
    if (next) {
      _runPreview(next.text)
    } else {
      previewBusyRef.current = false
    }
  }

  function playPreview(text) {
    if (!text.trim()) return
    if (previewBusyRef.current) {
      if (previewQueueRef.current.length < 10) {
        previewQueueRef.current.push({ text })
      }
      return
    }
    previewBusyRef.current = true
    _runPreview(text)
  }

  async function handleApprove(skipAll = false) {
    const phonetics = {}
    if (!skipAll) {
      for (const { original, phonetic } of words) {
        if (phonetic.trim()) phonetics[original] = phonetic.trim()
      }
    }
    try {
      const res = await fetch(`${API}/approve/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phonetics }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail ?? 'Failed to start conversion')
      }
      setJobStatus('converting')
      setProgress(0)
      startPolling(jobId)
    } catch (e) {
      setError(e.message)
    }
  }

  function handleDownload() {
    window.open(`${API}/download/${jobId}`, '_blank')
  }

  function reset() {
    clearInterval(pollRef.current)
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    previewQueueRef.current = []
    previewBusyRef.current = false
    setFile(null)
    setJobId(null)
    setJobStatus(null)
    setProgress(0)
    setError(null)
    setVoice('af_heart')
    setEngine('kokoro')
    setChapters([])
    setEditedText('')
    setFileType('txt')
    setPerChapter(true)
    setWords([])
    setPlayingWord(null)
    setPhoneticSources({})
    setPhoneticAlternatives({})
    setDraftSavedAt(null)
    setScanMethod('regex')
    setScanUnknown(false)
    setOutputType('zip')
    setOutputIsChapters(false)
  }

  async function saveDraft() {
    if (!jobId || jobStatus !== 'awaiting_review') return
    const phonetics = {}
    for (const { original, phonetic } of words) {
      if (phonetic.trim()) phonetics[original] = phonetic.trim()
    }
    try {
      await fetch(`${API}/save-draft/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phonetics }),
      })
      setDraftSavedAt(new Date())
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (jobStatus !== 'awaiting_review' || !jobId) return
    const id = setInterval(saveDraft, 2 * 60 * 1000)
    return () => clearInterval(id)
  }, [jobStatus, jobId, words])

  const busy = ['uploading', 'queued', 'parsing', 'scanning', 'converting'].includes(jobStatus)

  const cardMaxWidth = jobStatus === 'awaiting_review' ? 720
    : jobStatus === 'text_preview' ? 960
    : 480

  return (
    <div style={s.page}>
      <div style={{ ...s.card, maxWidth: cardMaxWidth }}>
        <h1 style={s.title}>Ebook → Audiobook</h1>
        <p style={s.sub}>Upload an EPUB or TXT and get an MP3 — powered by Kokoro or Orpheus TTS</p>

        {/* ── File picker ── */}
        {!jobStatus && (
          <>
            <div
              style={{ ...s.drop, ...(dragging ? s.dropActive : {}) }}
              onClick={() => inputRef.current.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files[0]) }}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".epub,.txt"
                style={{ display: 'none' }}
                onChange={(e) => pickFile(e.target.files[0])}
              />
              {file
                ? <p style={s.fileName}>📄 {file.name}</p>
                : <p style={s.hint}>Drop your EPUB or TXT here, or <u>browse</u></p>}
            </div>
            {file && (
              <>
                <div style={s.enginePicker}>
                  <span style={s.voiceLabel}>Engine:</span>
                  {[
                    { value: 'kokoro',  label: 'Kokoro 82M' },
                    { value: 'orpheus', label: 'Orpheus 3B' },
                  ].map(({ value, label }) => (
                    <label key={value} style={s.voiceOption}>
                      <input
                        type="radio"
                        name="engine"
                        value={value}
                        checked={engine === value}
                        onChange={() => {
                          setEngine(value)
                          setVoice(value === 'orpheus' ? 'tara' : 'af_heart')
                        }}
                      />
                      {' '}{label}
                    </label>
                  ))}
                </div>
                <div style={s.voicePicker}>
                  <span style={s.voiceLabel}>Voice:</span>
                  {(engine === 'orpheus'
                    ? [
                        { value: 'tara', label: 'Tara (F)' },
                        { value: 'leah', label: 'Leah (F)' },
                        { value: 'jess', label: 'Jess (F)' },
                        { value: 'mia',  label: 'Mia (F)' },
                        { value: 'zoe',  label: 'Zoe (F)' },
                        { value: 'dan',  label: 'Dan (M)' },
                        { value: 'leo',  label: 'Leo (M)' },
                        { value: 'zac',  label: 'Zac (M)' },
                      ]
                    : [
                        { value: 'af_heart',   label: 'Heart (F)' },
                        { value: 'af_bella',   label: 'Bella (F)' },
                        { value: 'af_nova',    label: 'Nova (F)' },
                        { value: 'am_fenrir',  label: 'Fenrir (M)' },
                        { value: 'am_michael', label: 'Michael (M)' },
                        { value: 'am_echo',    label: 'Echo (M)' },
                        { value: 'bm_george',  label: 'George (M·UK)' },
                      ]
                  ).map(({ value, label }) => (
                    <label key={value} style={s.voiceOption}>
                      <input
                        type="radio"
                        name="voice"
                        value={value}
                        checked={voice === value}
                        onChange={() => setVoice(value)}
                      />
                      {' '}{label}
                    </label>
                  ))}
                </div>
                <button style={s.btn} onClick={handleUpload}>
                  Upload & Parse →
                </button>
              </>
            )}
          </>
        )}

        {/* ── Scanning / converting progress ── */}
        {busy && (
          <div style={s.progressWrap}>
            <p style={s.statusTxt}>{STATUS_LABELS[jobStatus] ?? jobStatus}</p>
            <div style={s.bar}><div style={{ ...s.fill, width: `${progress}%` }} /></div>
            <p style={s.pct}>{progress}%</p>
          </div>
        )}

        {/* ── Text preview & edit ── */}
        {jobStatus === 'text_preview' && (
          <TextPreviewPanel
            chapters={chapters}
            editedText={editedText}
            fileType={fileType}
            perChapter={perChapter}
            scanMethod={scanMethod}
            scanUnknown={scanUnknown}
            voice={voice}
            engine={engine}
            onChaptersChange={setChapters}
            onTextChange={setEditedText}
            onPerChapterChange={setPerChapter}
            onScanMethodChange={setScanMethod}
            onScanUnknownChange={setScanUnknown}
            onDeleteChapter={deleteChapter}
            onStripUnusual={applyStripUnusual}
            onStripQuotes={applyStripQuotes}
            onScan={proceedToScan}
            onConvert={proceedToConvert}
            apiBase={API}
          />
        )}

        {/* ── Phonetics review ── */}
        {jobStatus === 'awaiting_review' && (
          <ReviewPanel
            words={words}
            playingWord={playingWord}
            phoneticSources={phoneticSources}
            phoneticAlternatives={phoneticAlternatives}
            onUpdatePhonetic={updatePhonetic}
            onRemoveWord={removeWord}
            onAddWord={addWord}
            onPlay={playPreview}
            onApprove={() => handleApprove(false)}
            onSkip={() => handleApprove(true)}
            onSaveDraft={saveDraft}
            draftSavedAt={draftSavedAt}
            apiBase={API}
            voice={voice}
            engine={engine}
          />
        )}

        {/* ── Done ── */}
        {jobStatus === 'done' && (
          <div>
            <p style={s.success}>Your audiobook is ready!</p>
            <button style={s.btn} onClick={handleDownload}>
              {outputIsChapters ? 'Download Chapters (ZIP)' : 'Download Audiobook (ZIP)'}
            </button>
            <button style={{ ...s.btn, ...s.btnGray }} onClick={reset}>Convert another</button>
          </div>
        )}

        {/* ── Error ── */}
        {error && (
          <div style={s.errBox}>
            <p style={s.errTxt}>{error}</p>
            <button style={{ ...s.btn, ...s.btnGray }} onClick={reset}>Try again</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Text Preview Panel ────────────────────────────────────────────────────────

function TextPreviewPanel({
  chapters, editedText, fileType, perChapter, scanMethod, scanUnknown, voice, engine,
  onChaptersChange, onTextChange, onPerChapterChange, onScanMethodChange, onScanUnknownChange,
  onDeleteChapter, onStripUnusual, onStripQuotes,
  onScan, onConvert, apiBase,
}) {
  const [sampleLoading, setSampleLoading] = useState(false)
  const [sampleAudioUrl, setSampleAudioUrl] = useState(null)
  const sampleAudioRef = useRef(null)

  const inSync = editedText === chapters.map(c => c.text).join('\n\n')
  const isEpub = fileType === 'epub'
  const canUsePerChapter = inSync && isEpub && chapters.length > 1

  const totalChars = editedText.length
  const totalWords = editedText.split(/\s+/).filter(Boolean).length

  async function generateSample() {
    if (sampleLoading) return
    setSampleLoading(true)
    try {
      const sampleText = editedText.slice(0, 4000)
      const res = await fetch(`${apiBase}/sample`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sampleText, voice, engine }),
      })
      if (!res.ok) throw new Error('Sample generation failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (sampleAudioRef.current) {
        sampleAudioRef.current.pause()
        URL.revokeObjectURL(sampleAudioRef.current.src)
      }
      const audio = new Audio(url)
      sampleAudioRef.current = audio
      setSampleAudioUrl(url)
      audio.play()
    } catch (e) {
      console.error(e)
    } finally {
      setSampleLoading(false)
    }
  }

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      if (sampleAudioRef.current) {
        sampleAudioRef.current.pause()
      }
    }
  }, [])

  return (
    <div style={{ textAlign: 'left' }}>
      <p style={s.statusTxt}>
        Review the parsed text before converting.{' '}
        <span style={{ color: '#64748b', fontWeight: 400 }}>
          {totalWords.toLocaleString()} words · {totalChars.toLocaleString()} chars
          {isEpub && ` · ${chapters.length} chapter${chapters.length !== 1 ? 's' : ''}`}
        </span>
      </p>

      {/* ── Strip controls ── */}
      <div style={s.stripRow}>
        <span style={{ fontSize: 13, color: '#475569', fontWeight: 500 }}>Clean up:</span>
        <button style={s.stripBtn} onClick={onStripUnusual} title="Remove all non-ASCII characters (accents, special symbols, etc.)">
          Strip unusual Unicode
        </button>
        <button style={s.stripBtn} onClick={onStripQuotes} title="Remove all quotation mark characters">
          Strip all quotes
        </button>
      </div>

      {/* ── Main layout: chapters sidebar + text editor ── */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12, alignItems: 'flex-start' }}>

        {/* Chapter list (EPUB only) */}
        {isEpub && chapters.length > 0 && (
          <div style={s.chapterList}>
            <div style={s.chapterListHeader}>Chapters</div>
            {chapters.map((ch, i) => (
              <div key={i} style={s.chapterItem}>
                <div style={s.chapterItemTitle} title={ch.title}>{ch.title || `Chapter ${i + 1}`}</div>
                <div style={s.chapterItemMeta}>{ch.text.split(/\s+/).filter(Boolean).length.toLocaleString()} w</div>
                <button
                  style={s.chapterDeleteBtn}
                  title="Remove this chapter from the output"
                  onClick={() => onDeleteChapter(i)}
                >✕</button>
              </div>
            ))}
            {!inSync && (
              <p style={{ fontSize: 11, color: '#94a3b8', padding: '6px 8px', margin: 0 }}>
                Chapter list out of sync with manual edits
              </p>
            )}
          </div>
        )}

        {/* Text editor */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <textarea
            style={s.textArea}
            value={editedText}
            onChange={e => onTextChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>

      {/* ── Per-chapter toggle (EPUB only) ── */}
      {isEpub && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13, color: canUsePerChapter ? '#334155' : '#94a3b8', cursor: canUsePerChapter ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={perChapter && canUsePerChapter}
              disabled={!canUsePerChapter}
              onChange={e => onPerChapterChange(e.target.checked)}
            />
            Split into one MP3 per chapter
          </label>
          {!canUsePerChapter && inSync && chapters.length <= 1 && (
            <span style={{ fontSize: 12, color: '#94a3b8' }}>— requires multiple chapters</span>
          )}
          {!inSync && (
            <span style={{ fontSize: 12, color: '#94a3b8' }}>— unavailable after manual text edits</span>
          )}
        </div>
      )}

      {/* ── Sample generation ── */}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          style={{ ...s.btn, ...s.btnGray, margin: 0, fontSize: 13, padding: '9px 18px' }}
          onClick={generateSample}
          disabled={sampleLoading || !editedText.trim()}
        >
          {sampleLoading ? 'Generating sample…' : '▶ Generate sample (~first 5 pages)'}
        </button>
        {sampleAudioUrl && !sampleLoading && (
          <audio controls src={sampleAudioUrl} style={{ height: 32, flex: 1 }} />
        )}
      </div>

      {/* ── Scan method selector ── */}
      <div style={{ marginTop: 16, padding: '10px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: '#475569', marginRight: 12 }}>Name scan method:</span>
        {[
          { value: 'regex',  label: 'Fast (regex)',   desc: 'Detects mid-sentence capitalised words not in the English dictionary. Quick but may miss some names or include false positives.' },
          { value: 'spacy',  label: 'NLP (spaCy)',    desc: 'Uses a neural NER model to detect people, places, organisations, events, and more. Slower on first run while the model loads (~12 MB).' },
          { value: 'stanza', label: 'NLP (Stanza)',   desc: 'Stanford NLP biLSTM-CRF model. Stronger than spaCy at unusual names in fiction. Downloads ~200 MB on first run.' },
        ].map(({ value, label, desc }) => (
          <label key={value} style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, marginRight: 20, cursor: 'pointer', fontSize: 13, color: '#334155' }}>
            <input
              type="radio"
              name="scanMethod"
              value={value}
              checked={scanMethod === value}
              onChange={() => onScanMethodChange(value)}
              style={{ marginTop: 2 }}
            />
            <span>
              <strong>{label}</strong>
              <span style={{ display: 'block', fontSize: 11, color: '#94a3b8', maxWidth: 260 }}>{desc}</span>
            </span>
          </label>
        ))}
        <label style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: 13, color: '#334155', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={scanUnknown}
            onChange={e => onScanUnknownChange(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            <strong>Also scan for unknown words</strong>
            <span style={{ display: 'block', fontSize: 11, color: '#94a3b8', maxWidth: 360 }}>
              Flags non-dictionary words regardless of capitalisation — made-up terms, sci-fi jargon, technical neologisms, etc.
              Hyphens are split first so "bio-mechanical" isn't flagged. May add false positives.
            </span>
          </span>
        </label>
      </div>

      {/* ── Action buttons ── */}
      <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button style={s.btn} onClick={onScan}>
          Scan for names →
        </button>
        <button style={{ ...s.btn, ...s.btnGray }} onClick={onConvert}>
          Convert directly
        </button>
      </div>
    </div>
  )
}

// ── Review panel ─────────────────────────────────────────────────────────────

const VOICE_LABELS = {
  _global: 'All voices',
  af_heart: 'Heart (F)', af_bella: 'Bella (F)', af_nova: 'Nova (F)',
  am_fenrir: 'Fenrir (M)', am_michael: 'Michael (M)', am_echo: 'Echo (M)',
  bm_george: 'George (M·UK)',
  tara: 'Tara (F)', leah: 'Leah (F)', jess: 'Jess (F)', mia: 'Mia (F)',
  zoe: 'Zoe (F)', dan: 'Dan (M)', leo: 'Leo (M)', zac: 'Zac (M)',
}

const IPA_GROUPS = [
  { label: 'vowels',     chars: ['æ','ɑ','ɔ','ə','ɛ','ɜ','ɪ','ʊ','ʌ','ᵊ','ᵻ'] },
  { label: 'consonants', chars: ['ð','ŋ','ɡ','ɹ','ɾ','ʃ','ʒ','ʤ','ʧ','θ','ʔ'] },
]

function CharPalette({ onInsert, style = {} }) {
  return (
    <div style={{ padding: '5px 8px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', display: 'inline-flex', flexDirection: 'column', gap: 4, ...style }}>
      <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600, letterSpacing: '0.05em', lineHeight: 1 }}>IPA</span>
      {IPA_GROUPS.map(({ label, chars }) => (
        <div key={label} style={{ display: 'flex', gap: 3 }}>
          {chars.map(ch => (
            <button
              key={ch}
              onMouseDown={e => { e.preventDefault(); onInsert(ch) }}
              title={label + ': ' + ch}
              style={{ width: 24, height: 24, padding: 0, border: '1px solid #cbd5e1', borderRadius: 4, background: '#f8fafc', cursor: 'pointer', fontFamily: 'Georgia, serif', fontSize: 13, color: '#1e293b', lineHeight: 1, flexShrink: 0 }}
            >
              {ch}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function ReviewPanel({ words, playingWord, phoneticSources, phoneticAlternatives = {}, onUpdatePhonetic, onRemoveWord, onAddWord, onPlay, onApprove, onSkip, onSaveDraft, draftSavedAt, apiBase, voice, engine }) {
  const [showLexicon, setShowLexicon] = useState(false)
  const [addWordInput, setAddWordInput] = useState('')
  const [autoPreview, setAutoPreview] = useState(false)
  const activeInputRef = useRef(null)
  const [palettePos, setPalettePos] = useState(null) // null = hidden

  function insertChar(char) {
    if (!activeInputRef.current) return
    const { el, idx } = activeInputRef.current
    const start = el.selectionStart ?? el.value.length
    const end   = el.selectionEnd   ?? el.value.length
    const newVal = el.value.slice(0, start) + char + el.value.slice(end)
    onUpdatePhonetic(idx, newVal)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + char.length, start + char.length)
    })
  }

  function handlePhoneticFocus(e, idx) {
    activeInputRef.current = { el: e.target, idx }
    const rect = e.target.getBoundingClientRect()
    setPalettePos({ top: rect.bottom + 4, left: rect.left })
  }

  function handlePhoneticBlur() {
    setPalettePos(null)
  }
  const substitutionCount = words.filter(w => w.phonetic.trim()).length
  const lexiconCount = words.filter(w => phoneticSources[w.original] === 'lexicon').length

  return (
    <div style={{ textAlign: 'left' }}>
      {words.length === 0 ? (
        <p style={{ ...s.statusTxt, textAlign: 'center' }}>
          No unfamiliar words detected. Ready to convert.
        </p>
      ) : (
        <>
          <p style={s.statusTxt}>
            Found <strong>{words.length}</strong> unfamiliar word{words.length !== 1 ? 's' : ''}.{' '}
            {lexiconCount > 0 && <span style={{ color: '#059669' }}>{lexiconCount} from saved lexicon. </span>}
            {substitutionCount > 0
              ? <>{substitutionCount} ha{substitutionCount !== 1 ? 've' : 's'} suggested phonetics.</>
              : 'Add phonetic spellings below.'}
          </p>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <p style={{ ...s.hint2, margin: 0 }}>
              Click <strong>▶</strong> to hear how Kokoro pronounces the phonetic spelling. Edit
              the field if it sounds wrong. Words with an empty phonetic field keep their original spelling.
              <span style={{ color: '#059669', marginLeft: 6 }}>Saved</span> = from your lexicon.
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#475569', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={autoPreview}
                onChange={e => setAutoPreview(e.target.checked)}
              />
              Auto-preview on edit
            </label>
          </div>

          <div style={s.table}>
            <div style={{ ...s.row, ...s.header }}>
              <div style={s.cOrig}>Original word</div>
              <div style={s.cCount}>#</div>
              <div style={s.cPhon}>Phonetic spelling</div>
              <div style={s.cAct}>Preview / Ignore / Remove</div>
            </div>

            {words.map((w, i) => {
              const isPlaying = playingWord === (w.phonetic.trim() || w.original)
              const fromLexicon = phoneticSources[w.original] === 'lexicon'
              const isIgnored = w.phonetic.trim() === w.original
              const alts = !w.phonetic.trim() ? (phoneticAlternatives[w.original] ?? {}) : {}
              const altEntries = Object.entries(alts)
              return (
                <div key={w.original + i} style={{ ...s.row, background: i % 2 === 0 ? '#f8fafc' : '#fff' }}>
                  <div style={s.cOrig}>
                    <span style={{ fontWeight: 600 }}>{w.original}</span>
                    {fromLexicon && (
                      <span style={s.savedBadge} title="Loaded from your saved lexicon">saved</span>
                    )}
                    {isIgnored && (
                      <span style={{ ...s.savedBadge, background: '#fef9c3', color: '#92400e', borderColor: '#fde68a' }} title="Marked to use original spelling">ignored</span>
                    )}
                  </div>
                  <div style={s.cCount}>
                    <span style={s.countBadge}>{w.count ?? '—'}</span>
                  </div>
                  <div style={s.cPhon}>
                    <input
                      style={{ ...s.input, borderColor: isIgnored ? '#fde68a' : fromLexicon ? '#86efac' : '#e2e8f0' }}
                      value={w.phonetic}
                      placeholder="e.g. her-MY-oh-nee"
                      onChange={(e) => onUpdatePhonetic(i, e.target.value)}
                      onFocus={(e) => handlePhoneticFocus(e, i)}
                      onBlur={() => { handlePhoneticBlur(); if (autoPreview) onPlay(w.phonetic.trim() || w.original) }}
                    />
                    {altEntries.length > 0 && (
                      <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        <span style={{ fontSize: 10, color: '#94a3b8', lineHeight: '22px' }}>Other voices:</span>
                        {altEntries.map(([v, p]) => (
                          <button
                            key={v}
                            title={`Use pronunciation from ${VOICE_LABELS[v] ?? v}`}
                            style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#334155', cursor: 'pointer' }}
                            onClick={() => onUpdatePhonetic(i, p)}
                          >
                            {VOICE_LABELS[v] ?? v}: <em>{p}</em>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ ...s.cAct, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      title={w.phonetic.trim() ? 'Preview phonetic spelling' : 'Preview original word'}
                      style={{ ...s.iconBtn, background: isPlaying ? '#e0e7ff' : '#f1f5f9', color: '#4f46e5' }}
                      onClick={() => onPlay(w.phonetic.trim() || w.original)}
                    >
                      {isPlaying ? '⏹' : '▶'}
                    </button>
                    <button
                      title={isIgnored ? 'Revert — clear phonetic field' : 'Ignore — use original spelling as-is'}
                      style={{ ...s.iconBtn, background: isIgnored ? '#fef9c3' : '#f0fdf4', color: isIgnored ? '#92400e' : '#15803d' }}
                      onClick={() => {
                        const newPhonetic = isIgnored ? w.initialPhonetic : w.original
                        onUpdatePhonetic(i, newPhonetic)
                        onPlay(newPhonetic.trim() || w.original)
                      }}
                    >
                      {isIgnored ? '↺' : '~'}
                    </button>
                    <button
                      title="Remove from substitution list"
                      style={{ ...s.iconBtn, background: '#fef2f2', color: '#dc2626' }}
                      onClick={() => onRemoveWord(i)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── Add word manually ── */}
      <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#475569', fontWeight: 500, flexShrink: 0 }}>Add word:</span>
        <input
          style={{ ...s.input, width: 160, fontSize: 13 }}
          placeholder="e.g. Schneider"
          value={addWordInput}
          onChange={e => setAddWordInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { onAddWord(addWordInput); setAddWordInput('') } }}
        />
        <button
          style={{ ...s.iconBtn, background: '#f0fdf4', color: '#15803d', fontSize: 13, padding: '5px 12px' }}
          onClick={() => { onAddWord(addWordInput); setAddWordInput('') }}
        >
          + Add
        </button>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={s.btn} onClick={onApprove}>
          {substitutionCount > 0
            ? `Apply ${substitutionCount} substitution${substitutionCount !== 1 ? 's' : ''} & Convert`
            : 'Convert'}
        </button>
        {words.length > 0 && (
          <button style={{ ...s.btn, ...s.btnGray }} onClick={onSkip}>
            Skip — use original text
          </button>
        )}
        <button style={{ ...s.btn, ...s.btnGray }} onClick={onSaveDraft}>
          Save
        </button>
        {draftSavedAt && (
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            Saved {draftSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        <button
          style={{ ...s.btn, ...s.btnGray }}
          onClick={() => setShowLexicon(v => !v)}
        >
          {showLexicon ? 'Hide Lexicon' : 'Manage Saved Lexicon'}
        </button>
      </div>

      {showLexicon && (
        <LexiconPanel apiBase={apiBase} voice={voice} engine={engine} playingWord={playingWord} onPlay={onPlay} />
      )}

      {palettePos && (
        <CharPalette
          onInsert={insertChar}
          style={{ position: 'fixed', top: palettePos.top, left: palettePos.left, zIndex: 1000 }}
        />
      )}
    </div>
  )
}

// ── Lexicon panel ─────────────────────────────────────────────────────────────

const ALL_VOICES = [
  { value: '_global', label: 'All voices' },
  { value: 'af_heart', label: 'Heart (F)' }, { value: 'af_bella', label: 'Bella (F)' },
  { value: 'af_nova', label: 'Nova (F)' }, { value: 'am_fenrir', label: 'Fenrir (M)' },
  { value: 'am_michael', label: 'Michael (M)' }, { value: 'am_echo', label: 'Echo (M)' },
  { value: 'bm_george', label: 'George (M·UK)' },
  { value: 'tara', label: 'Tara (F)' }, { value: 'leah', label: 'Leah (F)' },
  { value: 'jess', label: 'Jess (F)' }, { value: 'mia', label: 'Mia (F)' },
  { value: 'zoe', label: 'Zoe (F)' }, { value: 'dan', label: 'Dan (M)' },
  { value: 'leo', label: 'Leo (M)' }, { value: 'zac', label: 'Zac (M)' },
]

function LexiconPanel({ apiBase, voice, engine, playingWord, onPlay }) {
  // entries: {word: {voice: phonetic}} — new per-voice format
  const [entries, setEntries] = useState(null)
  const [filter, setFilter] = useState('')
  const [voiceFilter, setVoiceFilter] = useState(voice)   // show current job's voice by default
  const [newWord, setNewWord] = useState('')
  const [newPhonetic, setNewPhonetic] = useState('')
  const [newVoice, setNewVoice] = useState(voice)
  const [saving, setSaving] = useState(false)
  // editing key: "word::voice" -> draft
  const [editingPhonetics, setEditingPhonetics] = useState({})

  async function load() {
    try {
      const res = await fetch(`${apiBase}/lexicon`)
      const data = await res.json()
      setEntries(data)
      const drafts = {}
      for (const [word, voiceMap] of Object.entries(data)) {
        for (const [v, phonetic] of Object.entries(voiceMap)) {
          drafts[`${word}::${v}`] = phonetic
        }
      }
      setEditingPhonetics(drafts)
    } catch {
      setEntries({})
    }
  }

  useEffect(() => { load() }, [])

  async function handleSaveEntry(word, v) {
    const key = `${word}::${v}`
    const phonetic = (editingPhonetics[key] ?? '').trim()
    if (!phonetic) return
    setSaving(true)
    try {
      await fetch(`${apiBase}/lexicon`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, phonetic, voice: v }),
      })
      setEntries(prev => ({ ...prev, [word]: { ...(prev[word] ?? {}), [v]: phonetic } }))
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteVoiceEntry(word, v) {
    try {
      await fetch(`${apiBase}/lexicon/${encodeURIComponent(word)}?voice=${encodeURIComponent(v)}`, { method: 'DELETE' })
      setEntries(prev => {
        const newVoiceMap = { ...(prev[word] ?? {}) }
        delete newVoiceMap[v]
        if (Object.keys(newVoiceMap).length === 0) {
          const next = { ...prev }
          delete next[word]
          return next
        }
        return { ...prev, [word]: newVoiceMap }
      })
      setEditingPhonetics(prev => {
        const next = { ...prev }
        delete next[`${word}::${v}`]
        return next
      })
    } catch { /* ignore */ }
  }

  async function handleAdd() {
    const w = newWord.trim()
    const p = newPhonetic.trim()
    const v = newVoice || '_global'
    if (!w || !p) return
    setSaving(true)
    try {
      await fetch(`${apiBase}/lexicon`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: w, phonetic: p, voice: v }),
      })
      setEntries(prev => ({ ...prev, [w]: { ...(prev[w] ?? {}), [v]: p } }))
      setEditingPhonetics(prev => ({ ...prev, [`${w}::${v}`]: p }))
      setNewWord('')
      setNewPhonetic('')
    } finally {
      setSaving(false)
    }
  }

  // Flatten entries into rows based on voice filter
  const rows = []   // {word, v, phonetic}
  if (entries) {
    for (const [word, voiceMap] of Object.entries(entries)) {
      if (filter && !word.toLowerCase().includes(filter.toLowerCase())) continue
      for (const [v, phonetic] of Object.entries(voiceMap)) {
        if (voiceFilter !== '__all' && v !== voiceFilter) continue
        rows.push({ word, v, phonetic })
      }
    }
  }
  rows.sort((a, b) => a.word.localeCompare(b.word) || a.v.localeCompare(b.v))

  const totalWords = entries ? Object.keys(entries).length : 0

  return (
    <div style={s.lexiconPanel}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14, color: '#334155' }}>
          Saved Lexicon {entries ? `(${totalWords} word${totalWords !== 1 ? 's' : ''})` : ''}
        </strong>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #e2e8f0', color: '#334155' }}
            value={voiceFilter}
            onChange={e => setVoiceFilter(e.target.value)}
          >
            <option value="__all">All voices</option>
            {ALL_VOICES.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <input
            style={{ ...s.input, width: 150, fontSize: 13 }}
            placeholder="Filter words…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>
      </div>

      {entries === null ? (
        <p style={{ color: '#94a3b8', fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#94a3b8', fontSize: 13 }}>
          {filter || voiceFilter !== '__all' ? 'No matches for current filter.' : 'Lexicon is empty. Entries are saved automatically when you approve substitutions.'}
        </p>
      ) : (
        <div style={{ ...s.table, maxHeight: 340, overflowY: 'auto', marginBottom: 12 }}>
          <div style={{ ...s.rowLex, ...s.header }}>
            <div>Word</div>
            <div style={{ fontSize: 11 }}>Voice</div>
            <div>Phonetic spelling</div>
            <div style={{ textAlign: 'right' }}>Actions</div>
          </div>
          {rows.map(({ word, v, phonetic }) => {
            const key = `${word}::${v}`
            const draft = editingPhonetics[key] ?? phonetic
            const changed = draft !== phonetic
            const isPlaying = playingWord === (draft.trim() || word)
            return (
              <div key={key} style={{ ...s.rowLex, background: '#fff', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{word}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  {VOICE_LABELS[v] ?? v}
                </div>
                <div>
                  <input
                    style={{ ...s.input, fontSize: 13, borderColor: changed ? '#f59e0b' : '#e2e8f0' }}
                    value={draft}
                    onChange={e => setEditingPhonetics(prev => ({ ...prev, [key]: e.target.value }))}
                    onBlur={() => { if (changed) handleSaveEntry(word, v) }}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveEntry(word, v) }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                  <button
                    title="Preview phonetic"
                    style={{ ...s.iconBtn, background: isPlaying ? '#e0e7ff' : '#f1f5f9', color: '#4f46e5', fontSize: 12 }}
                    onClick={() => onPlay(draft.trim() || word)}
                  >
                    {isPlaying ? '⏹' : '▶'}
                  </button>
                  {changed && (
                    <button
                      title="Save changes"
                      style={{ ...s.iconBtn, background: '#fef9c3', color: '#92400e', fontSize: 12 }}
                      onClick={() => handleSaveEntry(word, v)}
                    >
                      Save
                    </button>
                  )}
                  <button
                    title="Delete this voice entry"
                    style={{ ...s.iconBtn, background: '#fef2f2', color: '#dc2626', fontSize: 12 }}
                    onClick={() => handleDeleteVoiceEntry(word, v)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add new entry */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid #e2e8f0', paddingTop: 10 }}>
        <span style={{ fontSize: 13, color: '#475569', fontWeight: 500, flexShrink: 0 }}>Add entry:</span>
        <input
          style={{ ...s.input, width: 120, fontSize: 13 }}
          placeholder="Word"
          value={newWord}
          onChange={e => setNewWord(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
        />
        <input
          style={{ ...s.input, flex: 1, minWidth: 120, fontSize: 13 }}
          placeholder="Phonetic spelling"
          value={newPhonetic}
          onChange={e => setNewPhonetic(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
        />
        <select
          style={{ fontSize: 12, padding: '7px 8px', borderRadius: 6, border: '1px solid #e2e8f0', color: '#334155' }}
          value={newVoice}
          onChange={e => setNewVoice(e.target.value)}
        >
          {ALL_VOICES.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <button
          style={{ ...s.iconBtn, background: '#6366f1', color: '#fff', fontSize: 13, padding: '6px 14px' }}
          onClick={handleAdd}
          disabled={saving || !newWord.trim() || !newPhonetic.trim()}
        >
          Add
        </button>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: {
    minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    background: '#f8fafc', fontFamily: 'system-ui, sans-serif', padding: 16, paddingTop: 40,
  },
  card: {
    background: '#fff', borderRadius: 16, padding: '48px 40px',
    boxShadow: '0 4px 24px rgba(0,0,0,.08)', width: '100%', textAlign: 'center',
  },
  title:    { margin: '0 0 8px', fontSize: 26, fontWeight: 700 },
  sub:      { margin: '0 0 32px', color: '#64748b', fontSize: 14 },
  drop: {
    border: '2px dashed #cbd5e1', borderRadius: 12, padding: '40px 24px',
    cursor: 'pointer', transition: 'border-color .2s, background .2s', marginBottom: 16,
  },
  dropActive: { borderColor: '#6366f1', background: '#eef2ff' },
  hint:     { margin: 0, color: '#94a3b8' },
  hint2:    { color: '#64748b', fontSize: 13, marginBottom: 12, lineHeight: 1.5 },
  fileName: { margin: 0, color: '#6366f1', fontWeight: 600 },
  btn: {
    display: 'inline-block', margin: '8px 6px 0', padding: '12px 28px',
    background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8,
    fontSize: 15, fontWeight: 600, cursor: 'pointer',
  },
  btnGray:  { background: '#e2e8f0', color: '#475569' },
  progressWrap: { marginTop: 16 },
  statusTxt:    { color: '#334155', marginBottom: 12, fontWeight: 500 },
  bar:  { height: 10, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden' },
  fill: { height: '100%', background: '#6366f1', borderRadius: 99, transition: 'width .6s ease' },
  pct:  { color: '#64748b', marginTop: 8, fontSize: 13 },
  success:  { color: '#059669', fontWeight: 600, fontSize: 18, marginBottom: 16 },
  errBox:   { marginTop: 20, padding: 16, background: '#fef2f2', borderRadius: 10 },
  errTxt:   { color: '#dc2626', marginBottom: 12 },
  enginePicker: { display: 'flex', gap: 16, justifyContent: 'center', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' },
  voicePicker: { display: 'flex', gap: 16, justifyContent: 'center', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' },
  voiceLabel:  { fontWeight: 600, fontSize: 14, color: '#334155' },
  voiceOption: { fontSize: 14, color: '#475569', cursor: 'pointer' },

  // Text preview
  stripRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 },
  stripBtn: {
    padding: '5px 12px', background: '#f1f5f9', border: '1px solid #e2e8f0',
    borderRadius: 6, fontSize: 12, color: '#475569', cursor: 'pointer', fontWeight: 500,
  },
  textArea: {
    width: '100%', height: 420, padding: '12px 14px',
    border: '1px solid #e2e8f0', borderRadius: 8,
    fontSize: 13, fontFamily: 'monospace', lineHeight: 1.6,
    resize: 'vertical', boxSizing: 'border-box', outline: 'none',
    color: '#1e293b', background: '#fafafa',
  },
  chapterList: {
    width: 200, flexShrink: 0,
    border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden',
    maxHeight: 420, overflowY: 'auto',
  },
  chapterListHeader: {
    padding: '8px 10px', background: '#f8fafc',
    borderBottom: '1px solid #e2e8f0', fontWeight: 600,
    fontSize: 12, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  chapterItem: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 8px', borderBottom: '1px solid #f1f5f9',
    fontSize: 12,
  },
  chapterItemTitle: {
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: '#334155',
  },
  chapterItemMeta: { color: '#94a3b8', flexShrink: 0 },
  chapterDeleteBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: '#dc2626', padding: '0 2px', fontSize: 11, flexShrink: 0,
  },

  // Table (phonetics review)
  table:  { border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginTop: 8 },
  row:    { display: 'grid', gridTemplateColumns: '180px 48px 1fr 150px', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f1f5f9' },
  header: { background: '#f8fafc', fontWeight: 600, fontSize: 13, color: '#475569' },
  cOrig:  { fontSize: 14 },
  cCount: { textAlign: 'center', fontSize: 13 },
  countBadge: {
    display: 'inline-block', minWidth: 28, padding: '2px 6px',
    background: '#f1f5f9', color: '#64748b', borderRadius: 99,
    fontSize: 12, fontWeight: 600, textAlign: 'center',
  },
  cPhon:  { padding: '0 8px' },
  cAct:   { textAlign: 'right' },
  input:  {
    width: '100%', padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6,
    fontSize: 14, outline: 'none', boxSizing: 'border-box',
  },
  iconBtn: {
    padding: '6px 10px', border: 'none', borderRadius: 6,
    cursor: 'pointer', fontSize: 13, fontWeight: 600,
  },
  savedBadge: {
    marginLeft: 6, padding: '1px 6px', background: '#dcfce7', color: '#15803d',
    borderRadius: 99, fontSize: 11, fontWeight: 600, verticalAlign: 'middle',
  },
  lexiconPanel: {
    marginTop: 24, padding: 16, background: '#f8fafc',
    border: '1px solid #e2e8f0', borderRadius: 10,
  },
  rowLex: {
    display: 'grid', gridTemplateColumns: '160px 90px 1fr 120px',
    alignItems: 'center', padding: '7px 10px', gap: 8,
  },
}
