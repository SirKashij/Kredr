# Security

## Supported versions

Security fixes are only made for the [latest release](https://github.com/SirKashij/Kredr/releases/latest). Older releases do not receive fixes, so please check whether the issue still occurs there before reporting it.

## Reporting a vulnerability

Please do **not** report security vulnerabilities as public issues. Report them privately via [“Report a vulnerability”](https://github.com/SirKashij/Kredr/security/advisories/new) in the “Security” tab of this repository.

Helpful details:

- the versions of Kredr and Windows,
- the steps to reproduce the issue,
- what an attacker can achieve with it.

Kredr is maintained by a single person. I usually acknowledge a report within a week and keep you updated until it is resolved. Once the vulnerability is fixed, I will credit you in the advisory if you wish.

## What counts as a vulnerability

Kredr starts shells and Claude Code agents with the permissions of the signed-in user. Running commands there is intended. Examples of vulnerabilities:

- Code runs without the user initiating it, for example just by opening someone else's project or displaying a file.
- Content from a project (Markdown, file names, terminal output) escapes the user interface and reaches Kredr's core.
- Kredr reads or writes files beyond what the user asked for.
- The installer, the `PATH` entry or the Explorer context menu entries can be abused.

What Claude Code or any other program does inside a terminal is out of scope; please report such issues to that program.
