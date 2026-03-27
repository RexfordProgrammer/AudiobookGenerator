import os
import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup


def extract_text(file_path: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".epub":
        return _extract_epub(file_path)
    elif ext == ".txt":
        return _extract_txt(file_path)
    else:
        raise ValueError(f"Unsupported file format: {ext}")


def _extract_epub(path: str) -> str:
    book = epub.read_epub(path)
    parts = []
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        # Remove script/style noise
        for tag in soup(["script", "style"]):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def _extract_txt(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()
