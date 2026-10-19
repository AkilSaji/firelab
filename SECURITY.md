# Security policy

FireLab drives TVs over adb and runs local servers (the dashboard and the MCP
HTTP transport), so security reports matter to us.

## Report a problem

Please **don't open a public issue**. Use GitHub's private reporting instead:
the repository's **Security** tab > **Report a vulnerability**. Include what
you found, how to reproduce it and what an attacker could do. We'll reply as
soon as we can and credit you in the fix unless you'd rather not be named.

## What's in scope

- the dashboard and MCP HTTP servers (they bind to 127.0.0.1 and reject foreign
  Host/Origin headers; a way around that is a bug);
- anything that lets a page, trace file or device output run commands on the
  computer;
- `firelab wrap` APKs (they are debug builds with WebView debugging on, by
  design; use `--release` for apps you ship);
- secrets or personal data leaking into reports, traces or device profiles.

## Good to know

- adb gives full control of a TV. Only connect TVs you own, and turn ADB
  debugging off when you're done.
- Explore reports and traces include screenshots of your app and its logs.
  Check them before you share them.
