#!/usr/bin/env python3
"""RAG assistant demo — answers from a docs/ folder and cites sources.

Naive keyword retrieval (no vector DB) so it runs instantly for demos.
Usage:  python ask.py "your question"
"""
import glob
import os
import re
import sys

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-opus-4-8"
DOCS_GLOB = "docs/**/*"
TOP_K = 4


def load_chunks() -> list[dict]:
    """Split every doc into paragraph chunks tagged with their source file."""
    chunks = []
    for path in glob.glob(DOCS_GLOB, recursive=True):
        if not path.endswith((".md", ".txt")) or not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for para in re.split(r"\n\s*\n", text):
            para = para.strip()
            if len(para) > 20:
                chunks.append({"source": os.path.basename(path), "text": para})
    return chunks


def tokenize(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def retrieve(question: str, chunks: list[dict]) -> list[dict]:
    """Rank chunks by keyword overlap with the question."""
    q = tokenize(question)
    scored = []
    for c in chunks:
        overlap = len(q & tokenize(c["text"]))
        if overlap:
            scored.append((overlap, c))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:TOP_K]]


def answer(client: Anthropic, question: str, context: list[dict]) -> str:
    if not context:
        return "I couldn't find anything about that in the provided documents."
    ctx = "\n\n".join(f"[{c['source']}]\n{c['text']}" for c in context)
    prompt = (
        "Answer the question using ONLY the context below. If the answer is not "
        "in the context, say you don't have that information — do not guess. "
        "Cite the source file name(s) you used in parentheses.\n\n"
        f"# Context\n{ctx}\n\n# Question\n{question}"
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    return next(b.text for b in resp.content if b.type == "text")


def main() -> int:
    if len(sys.argv) < 2:
        print('Usage: python ask.py "your question"')
        return 1
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Set ANTHROPIC_API_KEY (export it, or use a .env file).")
        return 1

    question = " ".join(sys.argv[1:])
    chunks = load_chunks()
    if not chunks:
        print("No documents found in docs/. Add some .md or .txt files.")
        return 1

    context = retrieve(question, chunks)
    client = Anthropic()
    print(answer(client, question, context))
    if context:
        sources = sorted({c["source"] for c in context})
        print(f"\n— sources: {', '.join(sources)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
