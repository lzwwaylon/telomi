# Document Parsing Runtime

The authenticated document parser is used by file ingestion. Prime Search does
not run a second post-acquisition conversion pass. Provider children acquire
the material that Cornell Note Agents will read, and Runtime preserves that
material in immutable Source directories.

## Execution seam

1. File ingestion sends a trusted local document to the authenticated parser.
2. The parser returns a validated canonical document and copied assets.
3. File ingestion stores the resulting Markdown and metadata.
4. Research Provider children separately acquire complete Source material.
5. Organizer only reads Source metadata; Cornell Note Agents read the preserved
   logical Source directory.

The parser accepts only trusted local paths under its configured input root. It
rejects remote URLs, paths outside configured roots, symlinks, and oversized
inputs.

## Verification

`npm run test:document-parsing-runtime`
