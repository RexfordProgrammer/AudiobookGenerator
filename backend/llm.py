import json
import re
from abc import ABC, abstractmethod

import httpx

from config import load_config

# ── Prompt ──────────────────────────────────────────────────────────────────

_PROMPT = """\
You are helping a text-to-speech (TTS) model correctly pronounce proper nouns \
and unusual words from a book.

Review the words below. For each word that a TTS model would likely mispronounce \
(fantasy/sci-fi names, invented words, foreign names with unusual stress patterns, \
words with silent letters), provide a phonetic respelling using plain English \
letters that the TTS model can read naturally.

Rules:
- Use lowercase letters with hyphens between syllables
- Capitalize the stressed syllable (e.g. "her-MY-oh-nee", "DAY-neh-ris")
- Only include words that genuinely need respelling
- Skip common English words and well-known names that follow standard rules
  (London, Paris, John, Mary, etc.)

Words: {words}

Respond with ONLY a valid JSON object: {{"Word": "phonetic-spelling", ...}}
If no words need respelling, return {{}}"""


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
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.2,
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return _parse_json(content)


class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def get_phonetics(self, words: list[str]) -> dict[str, str]:
        prompt = _PROMPT.format(words=", ".join(words))
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": self.model,
                    "max_tokens": 2048,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            resp.raise_for_status()
            content = resp.json()["content"][0]["text"]
            return _parse_json(content)


def _parse_json(text: str) -> dict[str, str]:
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return {}


# ── Factory + batched helper ─────────────────────────────────────────────────

def get_provider() -> LLMProvider:
    cfg = load_config()
    if cfg["provider"] == "anthropic":
        return AnthropicProvider(
            api_key=cfg["api_key"],
            model=cfg.get("model", "claude-haiku-4-5-20251001"),
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
