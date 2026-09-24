# Cornell Note Agent

## Boundaries

Search and the cross-provider Organizer first produce an immutable Source directory. Runtime then materializes a Cornell Source View for each Source and starts a fresh Prime Agent. The Agent sees only:

- The read-only Cornell Source View, containing UTF-8 text and local image assets declared in the conversion manifest
- The Source ID
- The current user question
- The Cornell Note prompt and output contract

PDFs, DOCX files, audio, video, archives, and undeclared binary files remain in the immutable Source Artifact but do not enter the Agent View. Images referenced in converted Markdown retain their relative paths and can be viewed through IPython rich display; Evidence can still cite only exact line numbers in text files.

The Agent uses native IPython and the Python standard library to choose which files and regions to read. Network access is disabled, the Source is read-only, thinking is fixed to medium, and auto refine is disabled.

## Sole output

The Agent writes to the fixed `cornell-note.json` path and submits only `sections` at the top level. Each Section has a title, summary, and nonempty Cue Notes; each Cue has text and nonempty Evidence citing Source-relative paths and exact start and end line numbers.

Runtime supplies `schema_version` and `source_id` from the calling context and computes Evidence `content_sha256`. The Agent does not determine these persisted identities.

- When a Topic Plan is supplied, every Cue must submit `topic_refs` using the short Refs in that prompt. Runtime rejects unknown or duplicate Refs and maps them to confirmed Topic IDs. Use an empty array when no Topic matches.
- When Discovery is enabled, every Cue must submit `discovery.finding`. Submit an empty string when there is no finding; Runtime does not store empty findings. Conditional fields must not be submitted when their feature is disabled.

The authoritative field validation is `validateCornellNote` in `server/research/cornell-note-agent.ts`. The prompt supplies submission requirements using the same Topic Plan and Discovery switches.

When a Source contributes nothing to the question, `sections` may be empty. The system does not generate or store relevance grades, acceptance/rejection decisions, reasons, matched questions, Note types, Report Section routing, or unresolved questions.

## Runtime

Runtime owns only deterministic mechanisms:

1. Materialize a Cornell Source View containing only readable text and declared assets from the immutable Source.
2. Mount that View read-only. Reject missing readable text without falling back to original binary files.
3. Inject the corresponding member paths as reading navigation only when an existing Logical Source gains members or a member revision changes. Do not inject this mechanism context when nothing changed.
4. Validate output against the current Topic Plan and Discovery switches.
5. Supply the Source ID from the calling context and validate text-file paths and line ranges.
6. Compute and record `content_sha256` for each cited passage.
7. Reuse unchanged Notes by Source revision.
8. Save the accumulated results as a Cornell Note Snapshot.

Runtime does not judge semantic relevance, filter by grades, route Notes to predefined Report Sections, or repackage Agent output.

## Downstream consumers

- Report Writer progressively reads nonempty Cornell Notes through its dedicated Note Workspace `summary/catalog/search/get` Interface and makes its own semantic material-selection and section-organization decisions. Note files are not mounted in the Writer sandbox.
- The background Wiki Shard Builder runs alongside Report Writer, consuming frozen Cornell Notes to produce candidate Shards before Wiki Curator forms the final Edition. See [Wiki Shard Builder](modules/wiki-shard-builder.md) for input, execution, and recovery boundaries.
- Scheduled research records only processed Source revisions and Cornell Note counts, not retained/rejected dispositions.

The Note Workspace serves only Report Writer. Runtime provides pagination, limits, short Refs, lexical search, and read auditing for Writer without interpreting query semantics. The Wiki pipeline does not use the Note Workspace or its read tracking.
