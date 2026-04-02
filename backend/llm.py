import asyncio
import json
import re
import urllib.request
from abc import ABC, abstractmethod

from config import load_config

# ── Prompt ──────────────────────────────────────────────────────────────────

_PROMPT = """\
You are a TTS pronunciation specialist for the Kokoro TTS engine (American English). Your task is to provide phonetic respellings for proper nouns so the engine reads them correctly.

You may use one of two formats per word:

FORMAT A — Kokoro inline IPA (preferred for foreign/unusual names where you know the pronunciation):
    [DisplayName](/phonemes/)
    The display name is what appears in text. The phonemes are IPA symbols between the slashes.
    Do NOT include stress marks (ˈ ˌ) — they are not supported.
    Supported IPA symbols: A I O W Y b d f h i j k l m n p s t u v w z æ ð ŋ ɑ ɔ ə ɛ ɜ ɡ ɪ ɹ ɾ ʃ ʊ ʌ ʒ ʤ ʧ θ ᵊ ᵻ ʔ
    NEVER use: the length mark ː (U+02D0), a regular colon :, or any letter not in the list above.
    For long vowels, repeat the vowel symbol instead (e.g. ɑɑ not ɑː, iɪ not iː).
    Examples:
        "Kovacs"      -> "[Kovatch](/koʊvætʃ/)"
        "Loemanako"   -> "[Loemanako](/ləmɑɑnəkoʊ/)"
        "Roespinoedji"-> "[Roespinoedji](/roʊɛspɪnoʊɛdʒi/)"
        "Nagini"      -> "[Nagini](/nɑdʒiɪni/)"

FORMAT B — Simple English respelling (use when IPA is uncertain):
    A continuous lowercase string of English syllables — no spaces, hyphens, or punctuation.
    Examples:
        "Hermione"  -> "hermyownee"
        "Daenerys"  -> "dayneris"
        "Niamh"     -> "neev"

Rules:
    - Prefer FORMAT A for clearly foreign or non-English names where you are confident in the IPA.
    - Use FORMAT B when you are unsure of the exact phonemes.
    - You MUST include every word from the list — no omissions.

Words: {words}

Respond with ONLY a valid JSON object: {{"Word": "respelling", ...}}"""


# ── HTTP helper (stdlib only) ────────────────────────────────────────────────

def _http_post(url: str, headers: dict, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


# ── Provider interface ───────────────────────────────────────────────────────

class LLMProvider(ABC):
    @abstractmethod
    async def get_phonetics(self, words: list[str]) -> dict[str, str]:
        ...


class OpenAICompatibleProvider(LLMProvider):
    """Works with OpenAI, Ollama, LM Studio, and any OpenAI-compatible endpoint."""

    def __init__(self, api_key: str, base_url: str, model: str) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model

    async def get_phonetics(self, words: list[str]) -> dict[str, str]:
        prompt = _PROMPT.format(words=", ".join(words))
        data = await asyncio.to_thread(_http_post,
            f"{self.base_url}/chat/completions",
            {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            {"model": self.model, "messages": [{"role": "user", "content": prompt}], "temperature": 0.2},
        )
        return _parse_json(data["choices"][0]["message"]["content"])


class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def get_phonetics(self, words: list[str]) -> dict[str, str]:
        prompt = _PROMPT.format(words=", ".join(words))
        data = await asyncio.to_thread(_http_post,
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": self.api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
            {"model": self.model, "max_tokens": 2048, "messages": [{"role": "user", "content": prompt}]},
        )
        return _parse_json(data["content"][0]["text"])


class GeminiProvider(LLMProvider):
    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def get_phonetics(self, words: list[str]) -> dict[str, str]:
        prompt = _PROMPT.format(words=", ".join(words))
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent?key={self.api_key}"
        )
        data = await asyncio.to_thread(_http_post,
            url,
            {"Content-Type": "application/json"},
            {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.2, "thinkingConfig": {"thinkingBudget": 0}}},
        )
        return _parse_json(data["candidates"][0]["content"]["parts"][0]["text"])


_STRIP_CHARS = '\u02c8\u02cc'  # IPA stress marks ˈ ˌ — not used by Kokoro


def _parse_json(text: str) -> dict[str, str]:
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        try:
            raw = json.loads(match.group())
            return {k: v.translate(str.maketrans('', '', _STRIP_CHARS)) for k, v in raw.items()}
        except json.JSONDecodeError as e:
            print(f"[llm] JSON parse error: {e}\nRaw response: {text!r}", flush=True)
            return {}
    print(f"[llm] No JSON object found in response. Raw response: {text!r}", flush=True)
    return {}


# ── Factory + batched helper ─────────────────────────────────────────────────

def get_provider() -> LLMProvider:
    cfg = load_config()
    if cfg["provider"] == "anthropic":
        return AnthropicProvider(
            api_key=cfg["api_key"],
            model=cfg.get("model", "claude-haiku-4-5-20251001"),
        )
    if cfg["provider"] == "gemini":
        return GeminiProvider(
            api_key=cfg["api_key"],
            model=cfg.get("model", "gemini-2.5-flash"),
        )
    # openai or ollama — both use the OpenAI-compatible format
    return OpenAICompatibleProvider(
        api_key=cfg.get("api_key", "ollama"),
        base_url=cfg.get("base_url", "https://api.openai.com/v1"),
        model=cfg.get("model", "gpt-4o-mini"),
    )


async def get_phonetics_batched(
    words: list[str],
    batch_size: int = 50,
    on_batch=None,
    timeout: float = 45,
) -> dict[str, str]:
    """Call the LLM in batches and aggregate results.

    on_batch(batch_num, total_batches, batch_words) is called before each request.
    Each batch is cancelled after *timeout* seconds to prevent hanging.
    """
    provider = get_provider()
    results: dict[str, str] = {}
    total_batches = max(1, -(-len(words) // batch_size))  # ceil div
    for i in range(0, len(words), batch_size):
        batch = words[i : i + batch_size]
        batch_num = i // batch_size + 1
        if on_batch:
            on_batch(batch_num, total_batches, batch)
        try:
            batch_result = await asyncio.wait_for(
                provider.get_phonetics(batch), timeout=timeout
            )
            results.update(batch_result)
            print(f"[llm] Batch {batch_num}/{total_batches} → {len(batch_result)} mappings", flush=True)
        except asyncio.TimeoutError:
            print(f"[llm] Batch {batch_num}/{total_batches} timed out after {timeout}s — skipping", flush=True)
        except Exception as e:
            print(f"[llm] Batch {batch_num}/{total_batches} failed: {e}", flush=True)
    return results
