import asyncio
import json
import re
import urllib.request
from abc import ABC, abstractmethod

from config import load_config

# ── Prompt ──────────────────────────────────────────────────────────────────

_PROMPT = """\
You are a TTS pronunciation specialist. Your task is to provide phonetic respellings for the following list of proper nouns so that a text-to-speech engine reads them correctly.

Rules for Respelling:
    Build the respelling from real, common English words or syllables that a TTS engine already knows how to pronounce.
    Prefer splicing together recognisable English words or word-parts over inventing arbitrary letter combinations.
    The output must be all lowercase with no punctuation, hyphens, or spaces — one continuous string.
    Spell out all the words.

Approach:
    First ask: what sequence of English sounds matches this word?
    Then ask: what existing English words or word-fragments produce those sounds?
    Combine those fragments into a single lowercase string.

Example Substitutions:
    "Hermione" -> "hermyownee"   (her + my + own + ee)
    "Daenerys" -> "dayneris"     (day + ner + is)
    "Tyrion"   -> "teereon"      (teer + eon)
    "Caitlin"  -> "katelyn"      (kate + lyn)
    "Pneumonia"-> "newmoania"    (new + moan + ia)
    "Niamh"    -> "neev"         (sounds like the word "neeve")

Words: {words}

Respond with ONLY a valid JSON object: {{"Word": "respelling", ...}}
You MUST include every word from the list — no omissions. Even if a word seems straightforward, provide your best phonetic respelling so the TTS engine has explicit guidance."""


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
            {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.2}},
        )
        return _parse_json(data["candidates"][0]["content"]["parts"][0]["text"])


def _parse_json(text: str) -> dict[str, str]:
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
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


async def get_phonetics_batched(words: list[str], batch_size: int = 50) -> dict[str, str]:
    """Call the LLM in batches and aggregate results."""
    provider = get_provider()
    results: dict[str, str] = {}
    for i in range(0, len(words), batch_size):
        batch = words[i : i + batch_size]
        try:
            batch_result = await provider.get_phonetics(batch)
            results.update(batch_result)
        except Exception as e:
            print(f"[llm] Batch {i // batch_size} failed: {e}", flush=True)
    return results
