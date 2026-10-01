# 01: Skeleton + Config

**What to build:** Project skeleton with entry point, package.json, tsconfig, and config loading via SettingsManager. Extension loads in pi without errors. Config reads `press.model`, `press.warnTokens`, `press.forceTokens` from pi settings (project > global).

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] package.json declares pi extension entry point and peer deps
- [ ] tsconfig.json compiles without errors
- [ ] index.ts exports default factory, registers no tools yet
- [ ] config.ts reads press settings via SettingsManager, falls back to defaults on error
- [ ] pi -e D:/Code/pi-press loads the extension without error
