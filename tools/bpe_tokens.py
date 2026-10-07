# Real BPE token counts (OpenAI tokenizers as a proxy for LLM cost; Claude's tokenizer differs but behaves similarly).
# Usage: python tools/bpe_tokens.py file1 file2 ...   (needs `pip install tiktoken`)
import sys, json, tiktoken
encs = {name: tiktoken.get_encoding(name) for name in ("cl100k_base", "o200k_base")}
rows = {}
for path in sys.argv[1:]:
    text = open(path, encoding="utf-8").read()
    rows[path] = {name: len(e.encode(text)) for name, e in encs.items()} | {"bytes": len(text.encode())}
w = max(len(p) for p in rows)
print(f"{'file':<{w}} {'bytes':>9} {'cl100k':>9} {'o200k':>9}")
for p, r in rows.items():
    print(f"{p:<{w}} {r['bytes']:>9} {r['cl100k_base']:>9} {r['o200k_base']:>9}")
json.dump(rows, open("out/bpe_tokens.json", "w"), indent=2)
