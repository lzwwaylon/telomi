export type SearchRow = {
 section_ref: string; page_ref: string; kind: 'entity' | 'concept'; title: string;
 description: string; heading: string; body: string; source_titles: string[];
};
export type SearchRequest = {
 query?: string; terms?: string[]; mode?: 'any' | 'all'; scope?: 'all' | 'body';
 kind?: 'entity' | 'concept'; page_ref?: string; offset?: number; limit?: number;
};
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
function fail(message: string): never { throw new Error(`Wiki search: ${message}`); }
function term(value: unknown): string {
 if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 200) fail('each query or term must be non-empty text of at most 200 codepoints');
 return normalize(value);
}
function excerpt(value: string, needles: string[]): string {
 const normalized = normalize(value);
 const positions = needles.map(needle => normalized.indexOf(needle)).filter(index => index >= 0);
 const hit = positions.length ? Math.min(...positions) : 0;
 const chars = Array.from(value);
 // Map a normalized offset back to the original text, preserving spelling and casing.
 let low = 0, high = chars.length;
 while (low < high) {
  const mid = Math.floor((low + high + 1) / 2);
  if (normalize(chars.slice(0, mid).join('')).length <= hit) low = mid; else high = mid - 1;
 }
 const start = Math.max(0, low - 60);
 return chars.slice(start, start + 240).join('');
}

/** Discovery excerpts never establish full-read receipts. */
export function searchRows(rows: SearchRow[], request: SearchRequest) {
 if (!request || typeof request !== 'object' || Array.isArray(request)) fail('request must be an object');
 const allowed = ['query', 'terms', 'mode', 'scope', 'kind', 'page_ref', 'offset', 'limit'];
 if (Object.keys(request).some(key => !allowed.includes(key))) fail('unknown request field');
 const hasQuery = Object.hasOwn(request, 'query'), hasTerms = Object.hasOwn(request, 'terms');
 if (hasQuery === hasTerms) fail('provide exactly one of query or terms');
 if (hasTerms && (!Array.isArray(request.terms) || request.terms.length < 1 || request.terms.length > 12)) fail('terms must contain 1 to 12 phrases');
 const needles = [...new Set(hasQuery ? [term(request.query)] : request.terms!.map(term))];
 const mode = request.mode === undefined ? 'any' : request.mode;
 const scope = request.scope === undefined ? 'all' : request.scope;
 const offset = request.offset === undefined ? 0 : request.offset;
 const limit = request.limit === undefined ? 12 : request.limit;
 if (!['any', 'all'].includes(mode)) fail('mode must be any or all');
 if (!['all', 'body'].includes(scope)) fail('scope must be all or body');
 if (!Number.isSafeInteger(offset) || offset < 0) fail('offset must be a non-negative safe integer');
 if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40) fail('limit must be an integer from 1 to 40');
 if (request.kind !== undefined && !['entity', 'concept'].includes(request.kind)) fail('kind must be entity or concept');
 if (request.page_ref !== undefined && (typeof request.page_ref !== 'string' || !rows.some(row => row.page_ref === request.page_ref))) fail('unknown page_ref');
 const matches = [];
 // ponytail: linear scan is sufficient for this corpus; add an index when measured corpus growth warrants it.
 for (const row of rows) {
  if (request.kind !== undefined && row.kind !== request.kind || request.page_ref !== undefined && row.page_ref !== request.page_ref) continue;
  const fields: Array<[string, string]> = scope === 'body' ? [['body', row.body]] : [
   ['title', row.title], ['description', row.description], ['heading', row.heading], ['body', row.body], ...row.source_titles.map(value => ['source', value] as [string, string]),
  ];
  const normalized = fields.map(([field, value]) => [field, normalize(value)]);
  const matchedTerms = needles.filter(needle => normalized.some(([, value]) => value.includes(needle)));
  if (!matchedTerms.length || mode === 'all' && matchedTerms.length !== needles.length) continue;
  const matchedFields = [...new Set(normalized.filter(([, value]) => needles.some(needle => value.includes(needle))).map(([field]) => field))];
  const snippetField = fields.find(([field, value]) => field === 'body' && matchedTerms.some(needle => normalize(value).includes(needle)))
   ?? fields.find(([, value]) => matchedTerms.some(needle => normalize(value).includes(needle)))!;
  matches.push({section_ref: row.section_ref, page_ref: row.page_ref, title: row.title, heading: row.heading,
   matched_fields: matchedFields, matched_terms: matchedTerms, snippet: excerpt(snippetField[1], matchedTerms)});
 }
 return {total: matches.length, offset, limit, next_offset: offset + limit < matches.length ? offset + limit : null, matches: matches.slice(offset, offset + limit)};
}
