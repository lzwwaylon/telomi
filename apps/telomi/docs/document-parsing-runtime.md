# Document Parsing Runtime

File ingestion and Browser material acquisition share the local document
conversion interface. It transcribes audio when needed and sends trusted local
documents to the authenticated parser. Browser acquisition converts material in
its Provider Workspace without creating Goal ingestion jobs or Main Agent
document listings. Prime Search does not run a second post-acquisition conversion
pass: Runtime preserves the acquired readable material in immutable Source directories.

## Execution seam

Callers use `convertLocalDocument` in `server/research/documents/local-document.ts`.
File ingestion stores its returned Markdown, canonical document and metadata in
the Goal's ingestion artifacts. Browser acquisition stores them in the Provider
Workspace as Source evidence. Audio is transcribed before parsing; documents
go directly to the parser. The parser returns a validated canonical document and
copied assets. Organizer reads only Source metadata; Note Agents read the
preserved Logical Source through its Note Source View.

The parser accepts only trusted local paths under its configured input root. It
rejects remote URLs, paths outside configured roots, symlinks, and oversized
inputs.

## Verification

`npm run test:document-parsing-runtime`
