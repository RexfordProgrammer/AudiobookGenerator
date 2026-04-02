import json
from pathlib import Path

_CONFIG_FILE = Path(__file__).parent / "llm_config.json"

_DEFAULTS: dict = {
    "provider": "openai",                       # "openai", "anthropic", or "ollama"
    "api_key": "",
    "base_url": "https://api.openai.com/v1",    # override to http://localhost:11434/v1 for Ollama
    "model": "gpt-4o-mini",
}


def load_config() -> dict:
    if _CONFIG_FILE.exists():
        with open(_CONFIG_FILE, encoding="utf-8") as f:
            return {**_DEFAULTS, **json.load(f)}
    return _DEFAULTS.copy()
