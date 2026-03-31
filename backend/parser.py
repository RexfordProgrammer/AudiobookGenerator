import os
import re
from pathlib import Path

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup

# Typographic characters that break name-detection and TTS
_CHAR_REPLACEMENTS = {
    '\u2018': "'",   # LEFT SINGLE QUOTATION MARK
    '\u2019': "'",   # RIGHT SINGLE QUOTATION MARK
    '\u201a': "'",   # SINGLE LOW-9 QUOTATION MARK
    '\u201b': "'",   # SINGLE HIGH-REVERSED-9 QUOTATION MARK
    '\u201c': '"',   # LEFT DOUBLE QUOTATION MARK
    '\u201d': '"',   # RIGHT DOUBLE QUOTATION MARK
    '\u201e': '"',   # DOUBLE LOW-9 QUOTATION MARK
    '\u201f': '"',   # DOUBLE HIGH-REVERSED-9 QUOTATION MARK
    '\u2013': '-',   # EN DASH
    '\u2014': '--',  # EM DASH
    '\u2026': '...', # HORIZONTAL ELLIPSIS
    '\u00a0': ' ',   # NON-BREAKING SPACE
    '\u00ad': '',    # SOFT HYPHEN (invisible, causes mid-word splits)
}

# Block-level HTML tags — each one becomes its own paragraph
_BLOCK_TAGS = {
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'blockquote', 'pre', 'td', 'th', 'dd', 'dt',
    'section', 'article',
}

# Minimum chars a chapter item must produce to be included
_MIN_CHAPTER_CHARS = 50


def _clean_text(text: str) -> str:
    # Normalize line endings first
    text = text.replace('\r\n', '\n').replace('\r', '\n')

    # Replace typographic/fancy characters with ASCII equivalents
    for char, replacement in _CHAR_REPLACEMENTS.items():
        text = text.replace(char, replacement)

    # Collapse 3+ consecutive newlines down to 2 (one blank line = paragraph break)
    text = re.sub(r'\n{3,}', '\n\n', text)

    # Join single newlines (mid-paragraph line breaks from TXT files) with a space.
    # Double newlines (paragraph breaks) are left intact.
    text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)

    # Collapse multiple spaces
    text = re.sub(r'  +', ' ', text)

    # Remove spaces that crept in around apostrophes between word characters.
    text = re.sub(r"(?<=\w) ' (?=\w)", "'", text)  # both sides: "don ' t"
    text = re.sub(r"(?<=\w) '(?=\w)", "'", text)   # left only:  "don 't"
    text = re.sub(r"(?<=\w)' (?=\w)", "'", text)   # right only: "don' t"

    # Trim trailing whitespace per line
    text = '\n'.join(line.rstrip() for line in text.split('\n'))

    return text.strip()


def _item_blocks(soup: BeautifulSoup) -> list[str]:
    """Extract text blocks from a BeautifulSoup document (scripts/styles already removed)."""
    blocks = []
    for tag in soup.find_all(_BLOCK_TAGS):
        if tag.find_parent(_BLOCK_TAGS):
            continue  # handled by a parent block tag
        if tag.find(_BLOCK_TAGS):
            continue  # not a leaf — its children will be processed instead
        text = tag.get_text(separator=' ', strip=True)
        if text:
            blocks.append(text)

    if not blocks:
        # Fallback for documents with no recognisable block elements
        text = soup.get_text(separator=' ', strip=True)
        if text:
            blocks.append(text)

    return blocks


def _item_title(item, soup: BeautifulSoup) -> str:
    """Extract a chapter title from an epub item, with multiple fallbacks."""
    # 1. First <h1>, <h2>, or <h3> in the HTML
    for tag in soup.find_all(['h1', 'h2', 'h3']):
        t = tag.get_text(strip=True)
        if t:
            return t

    # 2. The EpubHtml.title attribute (from OPF manifest, if set)
    if hasattr(item, 'title') and item.title:
        return item.title

    # 3. Filename stem (e.g. "Section0001" from "Section0001.xhtml")
    name = getattr(item, 'file_name', '') or getattr(item, 'get_name', lambda: '')()
    stem = Path(name).stem
    if stem:
        return stem

    return ""


def extract_chapters(file_path: str) -> list[dict]:
    """
    Return a list of chapter dicts: [{title: str, text: str}].
    EPUB files are split by spine item; TXT files return a single entry.
    Items with fewer than _MIN_CHAPTER_CHARS of text are skipped.
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".epub":
        return _extract_epub_chapters(file_path)
    elif ext == ".txt":
        text = _extract_txt(file_path)
        return [{"title": Path(file_path).stem, "text": text}]
    else:
        raise ValueError(f"Unsupported file format: {ext}")


def extract_text(file_path: str) -> str:
    """Return the full book text as a single string (all chapters joined)."""
    chapters = extract_chapters(file_path)
    return '\n\n'.join(ch['text'] for ch in chapters)


def _extract_epub_chapters(path: str) -> list[dict]:
    book = epub.read_epub(path)

    # Pre-build id → item map (O(n) lookup vs O(n²) with get_item_with_id in a loop)
    item_map = {item.id: item for item in book.get_items()}

    chapters = []
    for spine_id, linear in book.spine:
        if linear == "no":
            continue  # skip footnotes, endnotes, supplementary docs

        item = item_map.get(spine_id)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue

        soup = BeautifulSoup(item.get_content(), "html.parser")
        for tag in soup(["script", "style"]):
            tag.decompose()

        blocks = _item_blocks(soup)
        if not blocks:
            continue

        text = _clean_text('\n\n'.join(blocks))
        if len(text) < _MIN_CHAPTER_CHARS:
            continue  # skip cover pages, nav docs, very short front matter

        title = _item_title(item, soup) or f"Chapter {len(chapters) + 1}"
        chapters.append({"title": title, "text": text})

    return chapters


def _extract_txt(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return _clean_text(f.read())
