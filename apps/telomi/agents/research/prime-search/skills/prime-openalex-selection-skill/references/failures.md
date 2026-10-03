# Precise failure handling

| Outcome/code | Meaning | Agent action |
|---|---|---|
| Successful empty page | No records for these filters/page | Review coverage; supplement only a genuinely uncovered need |
| `invalid_provider_request` / `provider_rejected_request` | Local parameters or native syntax rejected | Correct the identified parameter once; report if it remains invalid |
| `openalex_entity_not_found` | Exact W/T ID or DOI not indexed | Preserve that identity as a lead; request another source if required |
| `openalex_fulltext_missing` | This work has no cached PDF, or content returned 404 | Keep metadata; hand off this exact paper's full-text need |
| `openalex_fulltext_key_required` | Metadata works anonymously, cached PDF needs a free key | Hand off full-text need; other metadata operations remain available |
| `provider_daily_budget_exhausted` | Shared local free allowance or upstream daily budget exhausted | Stop all OpenAlex calls and submit partial Ledger |
| `provider_credentials` | Upstream rejected the configured access credential | Stop this Provider and report the error |
| `source_unavailable` | Runtime ended this Child's bounded recovery | Stop this Provider, submit partial Ledger and report original cause in details |
| `provider_rate_limit`, timeout, network or 5xx | Runtime-controlled recovery returned a failure | Preserve exact error and hand off; no Agent retry loop |
| `invalid_provider_response` / `empty_document` | Upstream format or converted material unusable | Preserve error and affected identity; report missing evidence |

The free-only admission ledger is shared by service instances on this machine and caps this service's usage. Other
applications or machines using the same key can consume its allowance; use a dedicated free account/key without prepaid
credit for a spending guarantee outside this service. The Agent never sets or rotates credentials.

Official references: [errors](https://help.openalex.org/api/errors/),
[authentication](https://help.openalex.org/api/authentication/),
[usage costs](https://help.openalex.org/access/example-costs/),
[full text](https://help.openalex.org/access/fulltext/).
