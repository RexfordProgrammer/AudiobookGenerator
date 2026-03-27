"""
Proper-noun detection, phonetic substitution, and lexicon persistence.

Storage layout:
  backend/phonetics/{job_id}.json   — per-session word list + approved phonetics
  backend/lexicon.json              — global accumulated lexicon (grows across sessions)
"""

import json
import re
from pathlib import Path

PHONETICS_DIR = Path(__file__).parent / "phonetics"
PHONETICS_DIR.mkdir(exist_ok=True)

LEXICON_FILE = Path(__file__).parent / "lexicon.json"

# Capitalized words that are safe to skip even when mid-sentence
_SKIP = {
    "January", "February", "March", "April", "June", "July",
    "August", "September", "October", "November", "December",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "God", "Lord", "King", "Queen", "Prince", "Princess", "Sir", "Lady",
    "Mr", "Mrs", "Ms", "Dr", "Prof", "Captain", "General", "President",
    "English", "American", "British", "French", "German", "Spanish", "Italian",
    "Roman", "Greek", "Latin", "Christian", "Catholic", "Jewish", "Muslim",
    "North", "South", "East", "West", "Northern", "Southern", "Eastern", "Western",
    "Chapter", "Part", "Book", "Volume", "Section", "Prologue", "Epilogue",
    "Yes", "No", "Oh", "Ah", "Well", "Now", "Then", "Here", "There",
}


def find_proper_nouns(text: str) -> list[str]:
    """
    Return sorted list of capitalized words that appear mid-sentence —
    likely proper nouns (character names, places, invented terms).
    """
    tokens = re.findall(r'\S+', text)
    proper_nouns: set[str] = set()

    for i, token in enumerate(tokens):
        if i == 0:
            continue

        # Strip surrounding punctuation to get the bare word
        word = re.sub(r"^[^a-zA-Z']+|[^a-zA-Z']+$", "", token)
        if not word or len(word) < 3:
            continue

        # Must be Title Case — starts with capital, not entirely upper-case (acronym)
        if not (word[0].isupper() and not word.isupper()):
            continue

        if word in _SKIP:
            continue

        # If the previous token ends with a sentence-ending character, this word
        # starts a new sentence and is therefore not a mid-sentence proper noun.
        prev = tokens[i - 1].rstrip('"\'')
        if prev and prev[-1] in ".!?":
            continue

        proper_nouns.add(word)

    return sorted(proper_nouns)


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
