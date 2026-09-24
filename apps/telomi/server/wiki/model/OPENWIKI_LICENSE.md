This module was originally adapted from
[langchain-ai/openwiki](https://github.com/langchain-ai/openwiki), commit
`9a02b3516fe1706d6e8f23557ac42f42a6d0896a`, and has since been rewritten. What
still derives from the upstream project is:

- the `CONTROL_MARKDOWN` filename set in `files.ts`, which is OpenWiki's
  on-disk wiki layout convention;
- the `WikiNode` and `WikiGraph` field shapes in `graph.ts`;
- the YAML parse options in `splitFrontmatter` (`frontmatter.ts`).

Everything else in this directory is Telomi's own. The graph builder,
`graphology` community detection, Adamic-Adar and source-overlap edge signals
have no upstream counterpart; OpenWiki does not depend on `graphology`. Wiki
indexing, link validation and Mermaid handling elsewhere in Telomi were written
independently and are not covered by this notice.

The attribution below is retained because the items listed above are copied
verbatim.

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
