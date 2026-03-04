---
name: write-code
description: Structured code-change workflow for DiceTilt. Invoke before making any non-trivial code changes.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

When making any code changes to this project, follow this process strictly.

## 1. Pre-Change Impact Analysis

Before writing a single line of code:
- Identify **all files** you will modify
- Trace how they are used (imports, callers, services that depend on them)
- Map the **data flows** affected (Redis keys, Kafka topics, DB tables, WS messages)
- Identify side effects (DB writes, cache mutations, queue publishes, external calls)
- Note any **TypeScript types or Zod schemas** in `packages/shared-types` that may be affected
- Ask: "What else could break?"

## 2. Define Goals

State explicitly:
- What should the code do **after** the change?
- What **must NOT change** (invariants — e.g. Redis key schema, Kafka message shape)?
- What are the **concrete success criteria**?

## 3. Make the Changes

Apply changes with the impact analysis in mind. Be surgical — change only what is necessary.

Key rules:
- Do not change config key names or Kafka message shapes without updating all consumers
- If modifying a Lua script in `redis.service.ts`, re-verify all callers pass the correct argument count
- If changing a Zod schema in `packages/shared-types`, rebuild shared-types before building dependent services
- TypeScript strict mode is on — no implicit `any`, no untyped catch bindings (`(e: unknown)`)

## 4. Verify

After changes:
- Confirm each goal is met
- Confirm dependent code still compiles (`pnpm build` or `tsc --noEmit`)
- Check that no imports are broken
- If modifying a service: `docker compose build <svc> && docker compose up -d --force-recreate <svc>` before testing

## 5. Self-Healing Loop

If verification fails:
1. Identify root cause (don't guess — read the error)
2. Fix it
3. Re-verify from Step 4
4. Repeat until all goals are met and no known errors remain

**Never declare a task complete with known build or runtime errors.**
