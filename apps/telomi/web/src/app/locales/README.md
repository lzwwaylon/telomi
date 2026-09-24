# UI language resources

Every UI string uses a stable message ID shared by all locale files.

To add a language:

1. Copy `en.ts`, rename the exported message object, and translate only the values.
2. Keep `satisfies Record<MessageId, string>` so TypeScript rejects missing or extra IDs.
3. Import the new resource in `index.ts` and add one `localeDefinitions` entry with its native name, text direction, and language aliases.

React components use `t("message.id")`. Non-React helpers use `uiText("message.id")`. Do not use visible Chinese or English copy as a lookup key.
