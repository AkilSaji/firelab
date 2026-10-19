**What this changes and why**

**How you tested it**
- [ ] `npm test` and `npx tsc --noEmit` pass
- [ ] Tested on a device or emulator (which?):
- [ ] New device output has a fixture in `test/fixtures/` with private data removed
- [ ] Changed MCP tools? Ran `npm run docs:tools`

**Adding a device profile?** Use this checklist instead:
- [ ] Only `profiles/<MODEL>.json`, recorded with `firelab profile` (FireLab version: )
- [ ] Fire OS version:
- [ ] Facts it couldn't measure are left as `unknown`; nothing typed in by hand
- [ ] No personal data in `notes` or `references`
