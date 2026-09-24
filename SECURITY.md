# Security policy

English | [简体中文](SECURITY.zh-CN.md)

## Supported versions

Only the current `main` branch receives security fixes while Telomi is in early
development.

## Reporting a vulnerability

Report vulnerabilities privately through the repository's GitHub Security
Advisories. Do not open a public issue for credential exposure, sandbox escape,
unauthorized filesystem access, or remote code execution.

Include affected versions, reproduction steps, impact, and any known
workaround. Remove credentials and personal data from logs or artifacts.

## Deployment boundary

Telomi is an unauthenticated, local, single-user application. Its API binds to
`127.0.0.1` by default. Do not set `TELOMI_HOST=0.0.0.0` or expose the API
through a tunnel or reverse proxy without adding an authenticated access layer.
