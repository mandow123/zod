# TOP video visual integration

`TopVideoHero` is a decorative, reusable React Native presentation component. It is used only by the Home and Provider Workspace top sections and references the tracked local server-room MP4 and poster directly; no media has been copied and no remote media is loaded.

Run the normal non-production checks from this checkout with the bundled Node runtime:

```sh
npm run typecheck
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test test/top-video-visual-integration.test.mjs
```

For a local Android development preflight, use the existing direct-CN debug path only when the local Android/Expo toolchain is available. Do not use a release build, signing command, deployment, or distribution command.

The component loops muted media without controls only while the app is active and the device has not requested reduced motion. The poster remains the static fallback and all account, workspace, cache/error, next-action, callback, and navigation behavior stays outside the component.
