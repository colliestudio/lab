// Files written by `backlog` 1.53.0 (task create): the oracle's own output, for tests.
export const CLI_TASK = `---
id: TASK-1
title: First task
status: To Do
assignee:
  - '@dev'
created_date: '2026-10-16 14:53'
labels:
  - canvas
  - ui
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Does the thing
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 one
- [ ] #2 two
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
step 1
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
n1
<!-- SECTION:NOTES:END -->
`;
export const CLI_CHILD = `---
id: TASK-1.1
title: Child
status: In Progress
assignee: []
created_date: '2026-10-16 14:53'
labels: []
dependencies: []
parent_task_id: TASK-1
ordinal: 2000
---


`;
export const CLI_PLAIN = `---
id: TASK-2
title: 'Plain: with ''quote'' #1 é'
status: To Do
assignee: []
created_date: '2026-10-16 14:53'
labels: []
dependencies: []
ordinal: 3000
---


`;
export const CLI_CONFIG = `project_name: "demo"
default_status: "To Do"
statuses: ["To Do", "In Progress", "Done"]
labels: ["demo", "ui", "canvas"]
date_format: yyyy-mm-dd
max_column_width: 20
auto_open_browser: false
default_port: 6499
remote_operations: false
auto_commit: false
filesystem_only: false
bypass_git_hooks: false
check_active_branches: false
active_branch_days: 30
task_prefix: "task"
backlog_directory: "backlog"
`;
