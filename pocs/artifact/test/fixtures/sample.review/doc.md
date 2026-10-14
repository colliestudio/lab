---
kind: review
title: Todo app sign-in and export
tldr: Adds sign-in with a session cookie and an export button.
risk: low
risk_why: UI only.
ask: Check the export error handling.
---

Overview text.

## Sign-in {#signin}

The user signs in; the server sets a cookie.

![screen](assets/shot.png)

```demo
src: demos/todo.replay
steps: [2, 3]
caption: Loading and adding todos
```

## Export {#export}

Export hits a broken endpoint.
