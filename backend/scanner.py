"""
Proper-noun detection, phonetic substitution, and lexicon persistence.

Storage layout:
  backend/phonetics/{job_id}.json   — per-session word list + approved phonetics
  backend/lexicon.json              — global accumulated lexicon (grows across sessions)
"""

import json
import re
from pathlib import Path

from spellchecker import SpellChecker

_spell = SpellChecker()  # loads English dictionary once at import time

PHONETICS_DIR = Path(__file__).parent / "phonetics"
PHONETICS_DIR.mkdir(exist_ok=True)

LEXICON_FILE = Path(__file__).parent / "lexicon.json"


_SENTENCE_ENDERS = set('.!?:;')


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

        # If the word is in the English dictionary, it's a common word, not a proper noun
        if _spell.known([word.lower()]):
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


def apply_phonetics(text: str, phonetics: dict[str, str]) -> str:
    """Replace each word in `phonetics` throughout `text` (whole-word match)."""
    if not phonetics:
        return text
    # Longest originals first to avoid partial replacements
    for original, phonetic in sorted(phonetics.items(), key=lambda x: -len(x[0])):
        text = re.sub(r'\b' + re.escape(original) + r'\b', phonetic, text)
    return text


# ── Persistence ──────────────────────────────────────────────────────────────

def save_job_phonetics(job_id: str, words: list[str], phonetics: dict[str, str]) -> None:
    """Write per-session tally file: all detected words + LLM phonetic suggestions."""
    with open(PHONETICS_DIR / f"{job_id}.json", "w") as f:
        json.dump({"words": words, "phonetics": phonetics}, f, indent=2)


def load_lexicon() -> dict[str, str]:
    if LEXICON_FILE.exists():
        with open(LEXICON_FILE) as f:
            return json.load(f)
    return {}


def merge_into_lexicon(phonetics: dict[str, str]) -> None:
    """Merge approved phonetics into the global lexicon."""
    lexicon = load_lexicon()
    lexicon.update(phonetics)
    with open(LEXICON_FILE, "w") as f:
        json.dump(lexicon, f, indent=2, sort_keys=True)
