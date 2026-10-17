"""Fail closed when an automatically generated patrol PDF loses pages or links."""
import json
import sys
from pypdf import PdfReader

pdf_path, expected_links, expected_rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
reader = PdfReader(pdf_path)
texts = [page.extract_text() or "" for page in reader.pages]
links = sum(
    1
    for page in reader.pages
    for ref in page.get("/Annots", [])
    if ref.get_object().get("/A", {}).get("/URI")
)
if not texts or any(not text.strip() for text in texts):
    raise ValueError("PDF has an empty page")
if links != expected_links or sum(map(len, texts)) < expected_rows * 8:
    raise ValueError("PDF text or original-post links are incomplete")
print(json.dumps({"pages": len(texts), "links": links, "text_chars": sum(map(len, texts))}))
