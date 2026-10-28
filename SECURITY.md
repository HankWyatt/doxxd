# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: open the repository's **Security** tab, choose **Report a vulnerability**, and describe the problem, the affected version or commit, and steps to reproduce it. This opens a private advisory visible only to the maintainer.

Please do not open a public issue or pull request for a vulnerability, and do not include working exploits against third-party services.

Doxxd is maintained by one person on a best-effort basis. I will acknowledge a report as soon as I can, keep you updated, and credit you in the fix unless you prefer otherwise.

## Never post credentials

Never paste API keys, tokens, private keys or seed phrases into issues, pull requests, discussions or logs, and never commit them. If you accidentally expose a DMND API key, revoke and rotate it with DMND immediately; deleting the post is not enough.

## Scope

Doxxd is a read-only explorer for public wallet data. It never asks for a wallet connection, a signature or a private key. Server credentials are read from the server environment and are never sent to the browser. Reports about credential exposure, SSRF or redirect handling in the gateway, validation bypasses, or cross-wallet data mix-ups are especially welcome. Vulnerabilities in the DMND service itself or in third-party dependencies should be reported to their owners.
