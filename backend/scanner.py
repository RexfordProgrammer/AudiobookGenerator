"""
Proper-noun detection, phonetic substitution, and lexicon persistence.

Storage layout:
  backend/phonetics/{book_title}_names.json  — per-book word list + approved phonetics
  backend/phonetics/scan_cache.json          — legacy monolithic cache (read-only fallback)
  backend/lexicon.json                       — global accumulated lexicon (grows across sessions)
"""

import json
import re
from collections import defaultdict
from pathlib import Path

from spellchecker import SpellChecker

_spell = SpellChecker()  # loads English dictionary once at import time

# spaCy and Stanza are loaded lazily — only when requested
_nlp = None
_stanza_nlp = None

def _get_nlp():
    global _nlp
    if _nlp is None:
        import spacy
        _nlp = spacy.load("en_core_web_sm")
        _nlp.max_length = 5_000_000
    return _nlp

def _get_stanza():
    global _stanza_nlp
    if _stanza_nlp is None:
        import stanza
        stanza.download("en", processors="tokenize,ner")
        _stanza_nlp = stanza.Pipeline("en", processors="tokenize,ner", verbose=False)
    return _stanza_nlp

PHONETICS_DIR = Path(__file__).parent / "phonetics"
PHONETICS_DIR.mkdir(exist_ok=True)

LEXICON_FILE = Path(__file__).parent / "lexicon.json"
SCAN_CACHE_FILE = PHONETICS_DIR / "scan_cache.json"  # legacy


def _safe_name(filename: str) -> str:
    """Convert a filename stem to a safe, readable filesystem name."""
    return re.sub(r'[^\w\s-]', '', filename).strip().replace(' ', '_') or "unknown"


def _names_file(filename: str) -> Path:
    """Return the per-book names file path: phonetics/{safe_title}-names.json."""
    return PHONETICS_DIR / f"{_safe_name(filename)}-names.json"


_SENTENCE_ENDERS = set('.!?:;')

_CONTRACTION_RE = re.compile(r"n't$|'re$|'ve$|'ll$|'d$|'m$", re.IGNORECASE)


def find_unknown_words(text: str) -> list[tuple[str, int]]:
    """
    Find words that aren't in the English dictionary — made-up terms, sci-fi
    jargon, technical neologisms, foreign loanwords, etc.

    Preprocessing: every character except ASCII letters and apostrophes is
    replaced with a space.  This splits hyphenated compounds ("bio-mechanical"
    → "bio" + "mechanical") so their real-word parts are checked individually,
    while true neologisms ("biopunk", "neurochem") remain as single tokens and
    are flagged.  Contractions are stripped to their base ("couldn't" → "could")
    so they don't produce false positives.
    """
    clean = re.sub(r"[^a-zA-Z']", ' ', text)
    counts: dict[str, int] = {}

    for token in clean.split():
        word = token.strip("'")
        word = _CONTRACTION_RE.sub("", word)
        word = re.sub(r"'[sS]$", "", word)
        if "'" in word:          # remaining apostrophe = unusual contraction
            continue
        if len(word) < 4:
            continue
        if word.isupper():       # acronym (NASA, TTS, …)
            continue
        if not word.isalpha():
            continue

        if _spell.word_usage_frequency(word.lower()) > 0:
            continue             # known English word

        counts[word] = counts.get(word, 0) + 1

    return sorted(counts.items(), key=lambda x: x[1], reverse=True)


def find_proper_nouns(text: str) -> list[tuple[str, int]]:
    """
    Return list of (word, count) pairs for all mid-sentence capitalized words
    (likely names, places, or proper nouns) that TTS may need phonetic guidance on.
    Sorted by frequency of appearance in the text (most frequent first).
    """
    # Use finditer to preserve position info for newline detection
    token_matches = list(re.finditer(r'\S+', text))
    counts: dict[str, int] = {}

    for i, match in enumerate(token_matches):
        if i == 0:
            continue

        token = match.group()
        # Strip surrounding punctuation, keep internal apostrophes/hyphens
        word = re.sub(r"^[^a-zA-Z']+|[^a-zA-Z']+$", "", token)
        if not word or len(word) < 3:
            continue

        # Must be Title Case — starts with capital, not entirely upper-case (acronym)
        if not (word[0].isupper() and not word.isupper()):
            continue

        # Skip high-frequency common English words (freq > 1e-6 in the corpus).
        # Low threshold keeps common names like "Tanya" or "Schnider" that happen
        # to appear in the spell checker's frequency list.
        if _spell.word_usage_frequency(word.lower()) > 1e-6:
            continue

        prev_match = token_matches[i - 1]

        # If there's a newline between tokens, this is a paragraph/line start
        gap = text[prev_match.end():match.start()]
        if '\n' in gap:
            continue

        # If the previous token ends a sentence, this is sentence-start capitalisation
        # Also treat em-dashes as clause breaks
        prev = prev_match.group().rstrip('"\'')
        if not prev:
            continue
        if prev[-1] in _SENTENCE_ENDERS:
            continue
        if prev in ('—', '–', '-') or prev.endswith('—') or prev.endswith('–'):
            continue

        counts[word] = counts.get(word, 0) + 1

    return sorted(counts.items(), key=lambda item: item[1], reverse=True)


_SPACY_LABELS = {"PERSON", "GPE", "LOC", "ORG", "NORP", "FAC", "EVENT", "WORK_OF_ART", "PRODUCT"}


def find_proper_nouns_spacy(text: str) -> list[tuple[str, int]]:
    """
    Use spaCy NER to find named entities (people, places, orgs, etc.) that TTS
    may need phonetic guidance on. Filters out plain English dictionary words.
    Returns (word, count) sorted by frequency descending.
    """
    nlp = _get_nlp()
    counts: dict[str, int] = defaultdict(int)

    # Process in chunks to stay well within memory limits
    chunk_size = 500_000
    for start in range(0, len(text), chunk_size):
        chunk = text[start:start + chunk_size]
        doc = nlp(chunk)
        for ent in doc.ents:
            if ent.label_ not in _SPACY_LABELS:
                continue
            # For multi-word entities, also count each capitalised token individually
            tokens = ent.text.split()
            for token in tokens:
                word = re.sub(r"^[^a-zA-Z']+|[^a-zA-Z']+$", "", token)
                if not word or len(word) < 3:
                    continue
                if not (word[0].isupper() and not word.isupper()):
                    continue
                # spaCy already identified this as a named entity — trust it.
                # Don't filter by spell checker; common names like "Tanya" appear
                # in frequency corpora and would be incorrectly excluded.
                counts[word] += 1

    return sorted(counts.items(), key=lambda item: item[1], reverse=True)


_STANZA_LABELS = {"PERSON", "GPE", "LOC", "ORG", "NORP", "FAC", "EVENT", "WORK_OF_ART", "PRODUCT"}


def find_proper_nouns_stanza(text: str) -> list[tuple[str, int]]:
    """
    Use Stanza (Stanford NLP) NER to find named entities. Stanza uses a
    biLSTM-CRF model trained on OntoNotes and is notably stronger than
    spaCy's small model at catching unusual names in fiction.
    Downloads ~200 MB English models on first run.
    Returns (word, count) sorted by frequency descending.
    """
    nlp = _get_stanza()
    counts: dict[str, int] = defaultdict(int)

    # Stanza can handle large docs but chunking keeps memory predictable
    chunk_size = 100_000
    for start in range(0, len(text), chunk_size):
        chunk = text[start:start + chunk_size]
        doc = nlp(chunk)
        for ent in doc.entities:
            if ent.type not in _STANZA_LABELS:
                continue
            tokens = ent.text.split()
            for token in tokens:
                word = re.sub(r"^[^a-zA-Z']+|[^a-zA-Z']+$", "", token)
                if not word or len(word) < 3:
                    continue
                if not (word[0].isupper() and not word.isupper()):
                    continue
                counts[word] += 1

    return sorted(counts.items(), key=lambda item: item[1], reverse=True)


def apply_phonetics(text: str, phonetics: dict[str, str]) -> str:
    """Replace each word in `phonetics` throughout `text` (whole-word match)."""
    if not phonetics:
        return text
    # Longest originals first to avoid partial replacements
    for original, phonetic in sorted(phonetics.items(), key=lambda x: -len(x[0])):
        phonetic = phonetic.lstrip('ˈ').replace('(/ˈ', '(/')
        text = re.sub(r'\b' + re.escape(original) + r'\b', phonetic, text)
    return text


# ── Persistence ──────────────────────────────────────────────────────────────

def save_job_phonetics(job_id: str, words: list[str], phonetics: dict[str, str]) -> None:
    """Write per-session tally file: all detected words + LLM phonetic suggestions."""
    with open(PHONETICS_DIR / f"{job_id}.json", "w", encoding="utf-8") as f:
        json.dump({"words": words, "phonetics": phonetics}, f, indent=2, ensure_ascii=False)


def load_scan_cache(filename: str, scan_method: str = "regex") -> list[tuple[str, int]] | None:
    """Return cached word list for *filename* and *scan_method*, or None if not found.

    Uses "words" key for regex (backwards compat) and "words_spacy" for spaCy.
    Falls back to the legacy monolithic scan_cache.json for old regex caches.
    """
    cache_key = "words" if scan_method == "regex" else f"words_{scan_method}"
    names_file = _names_file(filename)
    if names_file.exists():
        with open(names_file, encoding="utf-8") as f:
            data = json.load(f)
        words = data.get(cache_key, [])
        return [(w, c) for w, c in words] if words else None

    # Legacy fallback — monolithic scan_cache.json (regex only)
    if scan_method != "regex" or not SCAN_CACHE_FILE.exists():
        return None
    with open(SCAN_CACHE_FILE, encoding="utf-8") as f:
        cache = json.load(f)
    entry = cache.get(filename)
    if entry is None:
        return None
    # Support old format: {"words_with_counts": [...], "phonetics": {...}}
    if isinstance(entry, dict):
        return [(w, c) for w, c in entry.get("words_with_counts", [])]
    return [(w, c) for w, c in entry]


def save_scan_cache(
    filename: str,
    words_with_counts: list[tuple[str, int]],
    scan_method: str = "regex",
) -> None:
    """Persist the word list for *filename* into its per-book {title}-names.json file.

    Uses "words" key for regex (backwards compat) and "words_spacy" for spaCy,
    so both methods can be cached in the same file.
    """
    cache_key = "words" if scan_method == "regex" else f"words_{scan_method}"
    names_file = _names_file(filename)
    data: dict = {}
    if names_file.exists():
        with open(names_file, encoding="utf-8") as f:
            data = json.load(f)
    data[cache_key] = [[w, c] for w, c in words_with_counts]
    with open(names_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True, ensure_ascii=False)


def save_book_approved(filename: str, phonetics: dict[str, str]) -> None:
    """Merge approved phonetic substitutions into the book's {title}-names.json file.

    This keeps a per-book record of all approved substitutions so future books in the
    same series pick them up via the global lexicon and this file serves as an audit log.
    """
    if not phonetics:
        return
    names_file = _names_file(filename)
    data: dict = {}
    if names_file.exists():
        with open(names_file, encoding="utf-8") as f:
            data = json.load(f)
    approved = data.get("approved", {})
    approved.update(phonetics)
    data["approved"] = approved
    with open(names_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True, ensure_ascii=False)


def load_lexicon() -> dict[str, dict[str, str]]:
    """Load the global lexicon. Returns {word: {voice: phonetic}}.
    Migrates old flat-format {word: str} entries to {"_global": phonetic} on first read."""
    if not LEXICON_FILE.exists():
        return {}
    with open(LEXICON_FILE, encoding="utf-8") as f:
        data = json.load(f)
    needs_write = any(isinstance(v, str) for v in data.values())
    if needs_write:
        data = {k: ({"_global": v} if isinstance(v, str) else v) for k, v in data.items()}
        write_lexicon(data)
    return data


def write_lexicon(lexicon: dict[str, dict[str, str]]) -> None:
    with open(LEXICON_FILE, "w", encoding="utf-8") as f:
        json.dump(lexicon, f, indent=2, sort_keys=True, ensure_ascii=False)


def merge_into_lexicon(phonetics: dict[str, str], voice: str = "_global") -> None:
    """Merge approved phonetics for a specific voice into the global lexicon.
    Overwrites any existing entry for the same word+voice combination."""
    if not phonetics:
        return
    lexicon = load_lexicon()
    for word, phonetic in phonetics.items():
        if word not in lexicon:
            lexicon[word] = {}
        lexicon[word][voice] = phonetic
    write_lexicon(lexicon)


def _normalize_for_lookup(word: str) -> str:
    """Strip surrounding punctuation and possessive 's for fuzzy matching."""
    w = re.sub(r"^[^a-zA-Z]+|[^a-zA-Z]+$", "", word)
    w = re.sub(r"'[sS]$", "", w)
    return w


def _build_norm_map(lexicon: dict[str, dict[str, str]]) -> dict[str, str]:
    """Build normalized-key → original-key map for fuzzy lookup."""
    norm_map: dict[str, str] = {}
    for key in lexicon:
        norm = _normalize_for_lookup(key).lower()
        if norm not in norm_map:
            norm_map[norm] = key
    return norm_map


def _get_entry(lexicon: dict[str, dict[str, str]], word: str, norm_map: dict[str, str]) -> dict[str, str] | None:
    if word in lexicon:
        return lexicon[word]
    orig = norm_map.get(_normalize_for_lookup(word).lower())
    return lexicon.get(orig) if orig else None


def _resolve_entry(entry: dict[str, str], voice: str) -> str | None:
    """Pick best phonetic from a voice-map: prefer voice-specific, then _global."""
    return entry.get(voice) or entry.get("_global")


def lookup_in_lexicon(words: list[str], voice: str) -> dict[str, str]:
    """
    Check words against the global lexicon for the given voice.
    Prefers voice-specific entries, falls back to _global.
    Returns {word: phonetic} for words found.
    """
    lexicon = load_lexicon()
    if not lexicon:
        return {}
    norm_map = _build_norm_map(lexicon)
    result: dict[str, str] = {}
    for word in words:
        entry = _get_entry(lexicon, word, norm_map)
        if entry is None:
            continue
        phonetic = _resolve_entry(entry, voice)
        if phonetic is not None:
            result[word] = phonetic
    return result


def lookup_alternatives_in_lexicon(words: list[str], voice: str) -> dict[str, dict[str, str]]:
    """
    For words that have no entry for the given voice (and no _global fallback),
    return {word: {other_voice: phonetic}} showing alternatives from other voices.
    """
    lexicon = load_lexicon()
    if not lexicon:
        return {}
    norm_map = _build_norm_map(lexicon)
    result: dict[str, dict[str, str]] = {}
    for word in words:
        entry = _get_entry(lexicon, word, norm_map)
        if entry is None:
            continue
        # Only include words that have no usable entry for the current voice
        if _resolve_entry(entry, voice) is not None:
            continue
        others = {v: p for v, p in entry.items() if v != voice}
        if others:
            result[word] = others
    return result
