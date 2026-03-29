"""Quick test for the Gemini API key and endpoint."""
import json
import urllib.request

with open("llm_config.json") as f:
    cfg = json.load(f)

api_key = cfg["api_key"]
model = cfg.get("model", "gemini-2.0-flash")

url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
body = json.dumps({
    "contents": [{"parts": [{"text": "Say hello in one word."}]}],
    "generationConfig": {"temperature": 0.2}
}).encode()

req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        print(f"[OK] Model: {model}")
        print(f"[OK] Response: {text.strip()}")
except urllib.error.HTTPError as e:
    body_text = e.read().decode()
    print(f"[FAIL] HTTP {e.code}: {e.reason}")
    print(f"[FAIL] Details: {body_text}")
except Exception as e:
    print(f"[FAIL] {e}")
