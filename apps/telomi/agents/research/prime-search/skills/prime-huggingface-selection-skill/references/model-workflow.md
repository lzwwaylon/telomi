# Open-source model workflow

Use this branch for model repositories, weights, architecture, language support, deployment, or release evidence.

## Choose discovery

The assignment decides the path; a list of familiar names does not.

- When the assignment describes a category, an organization type, a time range, or coverage words such as inventory,
  landscape, directory or all, coverage starts with one call: read [Integrated model discovery](model-discovery.md)
  and run `discover_models()`. It returns every model its own fields do not exclude, in one result; you judge them,
  acquire what you keep and submit the Ledger. A name the assignment passes as a lead does not replace the category:
  look up one the result does not contain by that name, and report a lead neither found as unresolved in the
  completion reply.
- For Hub task, language, library, license, or other native tags, read [Tag filtering](tag-filtering.md).
- `models(search=...)` and other direct fields in [Native search](native-search.md) serve names and identifiers the
  assignment states, including everything the Hub holds for a named entity, project or term, or `repo_id` values
  already returned by discovery. Do not use them to enumerate a category.

Read only the references required by the assignment. When integrated discovery needs a tag lookup, follow its pointer
to Tag filtering and then return to the same discovery flow.

## Resolve and acquire

Treat the discovery result as review input. Complete required pagination of a native search before resolving the shortlist. Use
`model_info()` only for shortlisted repository IDs returned by that discovery or supplied as exact inputs. Hub
`created_at` and `updated_at` are repository timestamps, not necessarily release dates.

Call `model_card()` only for final candidates whose claims need the complete README. It returns the pinned Model Card
with `download_path`; pass that record to `CandidateLedger`. Do not fetch every discovery result's card. Preserve
`repo_id`, tags, creation and update times, downloads, likes, pipeline task, library, revision, and Model Card evidence.

Deduplicate model records by native `repo_id`. An inaccessible Model Card leaves that candidate unresolved while other
completed model candidates remain usable.
