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

  // Phonetics review state
  const [words, setWords] = useState([])
  const [playingWord, setPlayingWord] = useState(null)

  // Output info
  const [outputType, setOutputType] = useState('mp3')

  const pollRef = useRef(null)
  const inputRef = useRef(null)
  const audioRef = useRef(null)

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
          setWords(allWords.map(({ word, count }) => ({ original: word, phonetic: phoneticsMap[word] ?? '', count })))
        }

        if (data.status === 'done') {
          clearInterval(pollRef.current)
          setOutputType(data.output_type ?? 'mp3')
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
        body: JSON.stringify({ chapters: chapsToSend, per_chapter: usePerChapter }),
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

  async function playPreview(text) {
    if (!text.trim()) return
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
      if (audioRef.current) {
        audioRef.current.pause()
        URL.revokeObjectURL(audioRef.current.src)
      }
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => setPlayingWord(null)
      audio.onerror = () => setPlayingWord(null)
      audio.play()
    } catch (e) {
      setError(e.message)
      setPlayingWord(null)
    }
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
    setOutputType('mp3')
  }

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
            voice={voice}
            engine={engine}
            onChaptersChange={setChapters}
            onTextChange={setEditedText}
            onPerChapterChange={setPerChapter}
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
            onUpdatePhonetic={updatePhonetic}
            onRemoveWord={removeWord}
            onPlay={playPreview}
            onApprove={() => handleApprove(false)}
            onSkip={() => handleApprove(true)}
          />
        )}

        {/* ── Done ── */}
        {jobStatus === 'done' && (
          <div>
            <p style={s.success}>Your audiobook is ready!</p>
            <button style={s.btn} onClick={handleDownload}>
              {outputType === 'zip' ? 'Download Chapters (ZIP)' : 'Download MP3'}
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
  chapters, editedText, fileType, perChapter, voice, engine,
  onChaptersChange, onTextChange, onPerChapterChange,
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
            Output one MP3 per chapter (download as ZIP)
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

      {/* ── Action buttons ── */}
      <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
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

function ReviewPanel({ words, playingWord, onUpdatePhonetic, onRemoveWord, onPlay, onApprove, onSkip }) {
  const substitutionCount = words.filter(w => w.phonetic.trim()).length

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
            {substitutionCount > 0
              ? <>{substitutionCount} ha{substitutionCount !== 1 ? 've' : 's'} suggested phonetics.</>
              : 'Add phonetic spellings below.'}
          </p>
          <p style={s.hint2}>
            Click <strong>▶</strong> to hear how Kokoro pronounces the phonetic spelling. Edit
            the field if it sounds wrong. Words with an empty phonetic field keep their original spelling.
          </p>

          <div style={s.table}>
            <div style={{ ...s.row, ...s.header }}>
              <div style={s.cOrig}>Original word</div>
              <div style={s.cCount}>#</div>
              <div style={s.cPhon}>Phonetic spelling</div>
              <div style={s.cAct}>Preview / Remove</div>
            </div>

            {words.map((w, i) => {
              const isPlaying = playingWord === (w.phonetic.trim() || w.original)
              return (
                <div key={w.original + i} style={{ ...s.row, background: i % 2 === 0 ? '#f8fafc' : '#fff' }}>
                  <div style={s.cOrig}>
                    <span style={{ fontWeight: 600 }}>{w.original}</span>
                  </div>
                  <div style={s.cCount}>
                    <span style={s.countBadge}>{w.count ?? '—'}</span>
                  </div>
                  <div style={s.cPhon}>
                    <input
                      style={s.input}
                      value={w.phonetic}
                      placeholder="e.g. her-MY-oh-nee"
                      onChange={(e) => onUpdatePhonetic(i, e.target.value)}
                    />
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

      <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
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
  row:    { display: 'grid', gridTemplateColumns: '180px 48px 1fr 110px', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f1f5f9' },
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
}
