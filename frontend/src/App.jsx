import { useState, useRef } from 'react'

const API = 'http://localhost:8000'

const STATUS_LABELS = {
  uploading: 'Uploading…',
  queued: 'Queued…',
  parsing: 'Parsing book…',
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
  const [words, setWords] = useState([])        // [{original, phonetic}]
  const [playingWord, setPlayingWord] = useState(null)
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
    setWords([])
  }

  function startPolling(id) {
    clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/status/${id}`)
        const data = await res.json()
        setJobStatus(data.status)
        setProgress(data.progress ?? 0)

        if (data.status === 'awaiting_review') {
          clearInterval(pollRef.current)
          // Build editable word list; all detected words shown, only those with
          // LLM suggestions pre-populated — user can add/edit freely.
          const allWords = data.words ?? []
          const phoneticsMap = data.phonetics ?? {}
          setWords(allWords.map(w => ({ original: w, phonetic: phoneticsMap[w] ?? '' })))
        }

        if (data.status === 'done' || data.status === 'error') {
          clearInterval(pollRef.current)
          if (data.error) setError(data.error)
        }
      } catch {
        // network blip — keep polling
      }
    }, 1500)
  }

  async function handleUpload(scan = true) {
    if (!file) return
    setError(null)
    setJobStatus('uploading')

    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(`${API}/upload?scan=${scan}`, { method: 'POST', body: form })
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
        body: JSON.stringify({ text }),
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
    setWords([])
    setPlayingWord(null)
  }

  const busy = ['uploading', 'queued', 'scanning', 'parsing', 'converting'].includes(jobStatus)

  return (
    <div style={s.page}>
      <div style={{ ...s.card, maxWidth: jobStatus === 'awaiting_review' ? 720 : 480 }}>
        <h1 style={s.title}>Ebook → Audiobook</h1>
        <p style={s.sub}>Upload an EPUB or TXT and get an MP3 powered by Kokoro TTS</p>

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
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button style={s.btn} onClick={() => handleUpload(true)}>
                  Scan for Names →
                </button>
                <button style={{ ...s.btn, ...s.btnGray }} onClick={() => handleUpload(false)}>
                  Quick Convert (MP3)
                </button>
              </div>
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
            <button style={s.btn} onClick={handleDownload}>Download MP3</button>
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
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#f8fafc', fontFamily: 'system-ui, sans-serif', padding: 16,
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

  // Table
  table:  { border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginTop: 8 },
  row:    { display: 'grid', gridTemplateColumns: '180px 1fr 110px', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f1f5f9' },
  header: { background: '#f8fafc', fontWeight: 600, fontSize: 13, color: '#475569' },
  cOrig:  { fontSize: 14 },
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
