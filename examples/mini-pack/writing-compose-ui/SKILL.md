---
name: writing-compose-ui
description: Use when building or changing Jetpack Compose screens and components. Triggers on "add a compose screen", "build a composable", "make this UI in compose". Not for preview annotations, which writing-compose-previews covers.
---

# Writing Compose UI

Keep state hoisted, pass a `Modifier` as the first optional parameter, collect flows with
`collectAsStateWithLifecycle`.
