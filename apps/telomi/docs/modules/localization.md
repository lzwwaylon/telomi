# Localization

Telomi keeps three language choices independent:

- `uiLocale` controls product chrome, accessibility labels, dates, numbers, and plural forms.
- `outputLanguage` controls Main Agent replies and the Research, Report, Wiki, and Podcast pipeline for one Goal.
- `voiceLanguage` controls speech recognition. It does not follow either of the other settings.

## UI locale

The UI currently supports `zh-CN` and `en`. `web/src/app/locales/` owns the locale registry and the message resources; `web/src/app/i18n.ts` owns browser-language fallback, the persisted user choice, and `<html lang>` synchronization. UI copy uses `react-i18next`; dates, numbers, relative times, and language names use the native `Intl` APIs.

Runtime-generated Activity chrome follows `uiLocale` through the same registry. The Activity Projection
never puts finished copy on the wire: fixed chrome travels as a stable message id plus parameters
(`shared/events/activity-text.ts`), and `web/src/shared/lib/activity-text.ts` is the one place that
renders it. A plain string, or a `text` part inside a composed line, is content that keeps the language
it was written in: a Goal's research question, an Agent's own summary, an upstream error text. Copy the
Runtime itself stored earlier, such as a Wiki Job's interruption sentence or a finished Podcast's recorded
detail, is chrome rather than content, so a projection rebuilds it from the recorded status facts instead
of replaying the stored sentence. A record that also carries real content keeps that content in a field of
its own, as a Podcast Activity keeps the title of its source report: an addressing identifier such as a
cardId or an artifact path is never a fallback title, so a record without a title projects chrome alone.
Backends never receive `uiLocale` and never hold locale resources, and
the wire shape carries its own `schemaVersion`. An Artifact listing therefore travels as filenames and
facts and never as a display label: the UI derives the type wording a card shows from the filename
(`web/src/shared/artifact-preview/artifact-type.ts`), so one Artifact reads the same on every surface.

`web/src/app/locales/README.md` is the procedure for adding a locale. `UI_LOCALES` and the `LanguageSettings` options both derive from `localeDefinitions`, so one entry there is the only registration step. After adding one, run `npm test -- tests/web/test-i18n.ts`, `npm run typecheck`, and the production build, then exercise the main routes in a real browser at narrow and wide widths.

The i18n contract test rejects resource trees with missing keys.

## Goal output language

`shared/languages.ts` owns the accepted Goal output-language values. `auto` is resolved once at a Run boundary from the current request; the resolved language is persisted with the Research Run so retries and resume operations do not drift. An explicit Goal preference wins over input-language inference.

Main Agent, Research, Report, Wiki, and Podcast receive the same Goal preference. The Wiki outlives any single Run, so for it `auto` is resolved from the Goal's own title and description instead of one request; every Run then writes the same Wiki in the same language. Pages written before a language change are rewritten only when a later Wiki Curator Workset consumes them, so an Edition can hold both languages for a while. Source language remains evidence metadata and never overrides the requested output language.

Adding a new output language requires adding it to `OUTPUT_LANGUAGES`, exposing it in the Goal create/edit controls, and verifying the affected Agent behavior with real historical cases in the external evaluation environment. Do not add language-specific keyword branches to shared Prompts. How an Agent stage receives the resolved language is specified in [Product Agent Development](../development/agent-authoring.md#output-language).

## Voice language

Voice input retains its existing provider-facing language registry. The regional preference is stored for display, while STT receives the base language tag. `auto` omits the provider language hint. LiveKit receives the same captured voice preference instead of forcing Chinese.

Provider support is narrower than the registry in some deployments. Product copy must not claim a language is supported by STT or TTS until the selected provider has been verified.
