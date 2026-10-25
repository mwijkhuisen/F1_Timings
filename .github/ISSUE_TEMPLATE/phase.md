---
name: Phase
about: One phase of docs/plan/PHASES.md §3
title: 'P<N><x>: <name>'
labels: []
---

> docs/plan/PHASES.md §3 P<N><x> · Depends on: <phases> · Owner actions (PHASES §4): <A#, or none>

## Goal
<From PHASES §3.>

## Scope
**In**
- <item>

**Out**
- <item> → <phase>

## Deliverables
- <item>

## Acceptance criteria
Each criterion carries one tag: **[CI]** (a test or check in CI), **[box]** (a command on the VM), **[weekend]** (a real F1 session) or **[owner]** (PHASES §2).
- [ ] [CI] <criterion>

## How to run it
- Branch `claude/p<N><x>-<slug>`, conventional commits, a PR from `.github/pull_request_template.md` with evidence per criterion. Agents never merge; the owner merges once `ci` is green.
- Reviews (PHASES §2): a fresh-session `/code-review` for P1b, P1c, P2b, P2c and P2d; a security review for anything touching secrets, the firewall, Access, the token or the compose hardening.
- An **[U]** fact proven or disproven here is written back into ARCHITECTURE.md in the same PR.
