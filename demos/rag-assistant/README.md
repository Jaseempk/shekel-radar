# Demo — RAG assistant on internal docs (Offer A)

A minimal, working version of the secondary offer. Point it at a folder of documents; it answers questions using **only** those docs and **cites the source file**. No vector DB, no extra infra — it runs instantly so it's easy to demo.

## Run it (2 minutes)

```bash
cd demos/rag-assistant
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...        # or use a .env file
python ask.py "How many days do I have to request a refund?"
python ask.py "What happens on a new hire's first day?"
```

It retrieves the most relevant chunks from `docs/`, answers from them, and prints the source file(s). If the answer isn't in the docs, it says so instead of making something up.

## Use it in a sales conversation

1. Drop **the prospect's** real docs (SOPs, policies, FAQs, product manuals) into `docs/` — any `.md` or `.txt`.
2. Ask the questions their team asks all day.
3. Screen-record it answering instantly with the source cited.
4. Narration: *"This is trained on your docs — your team gets instant, sourced answers instead of digging through folders or pinging a colleague."*

## What you'd build for a paying client (the real pilot)
- Swap the naive keyword retrieval for proper embeddings + a vector store (you already know Chroma) for larger doc sets.
- Ingest from their real sources (Google Drive, Notion, a support inbox).
- Wrap it in a Slack bot or a simple web chat.
- Keep it in sync as docs change.

The "retrieve → answer with citations, refuse if unknown" core stays the same.

## Cost
Uses `claude-opus-4-8`. Fine as-is for a demo and most doc-assistant workloads.
