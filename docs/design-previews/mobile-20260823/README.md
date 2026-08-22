# Zod mobile design previews

This directory contains the independently runnable HTML previews used to review
the current Zod mobile design direction. These files do not modify or replace
the React Native application source.

## Preview entry points

- [Integrated mobile preview](./kai-mobile-v2-preview.html) — buyer/provider
  views, theme and palette controls, KAI/garlic network states, and formal
  particle modes.
- [Particle system review](./kai-particle-system-review.html) — five realistic
  mobile scenes and nine independently selectable particle treatments.
- [KAI disconnect review](./kai-mascot-disconnect-review.html) — source-locked
  K/A/I emotion and disconnect-state review board.
- [Mobile gap audit](./zod-mobile-gap-audit.md) — comparison between the remote
  product definition, current application routes, and preview coverage.

The assets/kai-mascots directory contains the 12 approved transparent K/A/I
emotion assets. The server-room video and poster are local dependencies of the
integrated mobile preview. The three kai-mascot-reference-*.png files are the
selected source character boards used by the disconnect review.

## Run locally

From the repository root:

    python -m http.server 4177 --bind 127.0.0.1 --directory docs/design-previews/mobile-20260823

Then open:

- http://127.0.0.1:4177/kai-mobile-v2-preview.html
- http://127.0.0.1:4177/kai-particle-system-review.html
- http://127.0.0.1:4177/kai-mascot-disconnect-review.html

The particle review saves scene, network, particle, palette, theme, size, and
motion selections in the URL so review states can be shared.
