# AGENTS.md: Engineering Playbook for 9Router

This document defines the mandatory operating procedure, engineering workflow, quality standards, task-tracking rules, and completion criteria for any coding agent working in the 9router repository.

**Goal**: Make agent work systematic, traceable, safe, reproducible, and difficult to leave partially completed.

**Rule**: Never rely on memory to track unfinished work. If something needs to be investigated, implemented, validated, reviewed, or documented, put it in the checklist. Never mark a task complete merely because the main code path works. Completion requires implementation, validation, reconciliation, final review, and commit.

---

## 1. Core Operating Principles

Every agent working in this repository **MUST**:

- Understand the task before editing any code.
- Inspect the existing implementation before proposing a new pattern.
- Create and maintain a task checklist for substantial work.
- Track every discovered task, requirement, validation step, and follow-up.
- Use structured workflows (Ultracode) rather than making ad-hoc changes.
- Delegate exploration to sub-agents when parallel investigation is useful.
- Validate changes incrementally before considering them complete.
- Review the final diff line by line where practical.
- Resolve all task-scoped checklist items.
- Commit completed work to Git immediately upon completion.
- Never silently leave unfinished work uncommitted.
- Never claim completion without evidence that the requested work is actually complete.

Agents **SHOULD**:

- Prefer extending existing project conventions over introducing new abstractions, libraries, architectural patterns, or dependencies.
- Reuse established patterns from similar features already implemented in the repository.
- Document assumptions and constraints explicitly in the checklist.

---

## 2. Mandatory Structured Workflow

Use a structured engineering workflow (Ultracode) for every non-trivial task. Follow this sequence:

1. **Understand** - Fully comprehend the requirement and expected behavior.
2. **Explore** - Inspect relevant files, architecture, and dependencies.
3. **Scope** - Explicitly define what is required vs. optional vs. out-of-scope.
4. **Plan** - Break down into concrete implementation units.
5. **Create checklist** - Build a detailed task list with checkboxes.
6. **Delegate exploration** - Use sub-agents for parallel investigations when useful.
7. **Implement** - Write code following repository conventions.
8. **Validate incrementally** - Test after meaningful implementation steps.
9. **Test** - Run comprehensive test suites.
10. **Review** - Inspect final diff and remove debug artifacts.
11. **Reconcile checklist** - Map requirements to implementation and validation.
12. **Inspect final diff** - Line-by-line review for errors.
13. **Commit** - Commit only relevant changes.
14. **Report completion** - Provide a concise completion report.

**Do not skip directly from task description to implementation unless the task is genuinely trivial** (e.g., changing a single string literal).

---

## 3. Pre-Task Repository Inspection

Before modifying code, inspect enough of the repository to understand the environment. At minimum, determine:

### Repository Structure
- Root directory contains `src/`, `open-sse/`, `cli/`, `tests/`, `docs/`
- Two published artifacts: dashboard+gateway (root `package.json`) and CLI launcher (`cli/`)
- Monorepo with Next.js dashboard, provider-agnostic routing engine (`open-sse/`), and CLI package

### Application Entry Points
- Dashboard gateway: `src/app/layout.js`, `src/app/api/...`
- Provider routing: `open-sse/handlers/chatCore.js`, `open-sse/executors/*`
- API routes: `/v1/*` mapped via `next.config.mjs` → `/api/v1/*`

### Package/Build System
- Runtime: Next.js 16.x with Turbopack
- Package manager: npm (check `package.json`)
- Build commands: `npm run dev`, `npm run build`, `npm run start`
- Bun variants available: `dev:bun`, `build:bun`, `start:bun`

### Framework/Runtime Details
- Plain JavaScript (ESM), no TypeScript
- Path alias `@/*` → `src/*` defined in `jsconfig.json`
- Default runtime port: 20128
- Dashboard served at `/dashboard`, API at `/v1`

### Coding Conventions
- No ESLint configs shown in current inspection (uses `eslint-config-next`)
- Formatting: standard JS formatting, no Prettier configuration found
- Comments: use JSDoc style for function documentation
- Naming: camelCase for variables/functions, PascalCase for components

### Lint/Type Configuration
- Linting: `npx eslint .` (config `eslint.config.mjs`)
- Type checking: Not used (plain JavaScript project)
- No type definitions found; use JSDoc annotations for clarity

### Test Framework
- Testing: Vitest in `tests/` directory
- Test discovery: `vitest.config.js` resolves aliases
- Commands: `npx vitest run`, `npx vitest run unit/example.test.js`
- Note: Test suite has ~938 pass, ~64 fail (baseline exists in `tests/__baseline__/`)

### Database Layer
- Persistence: SQLite layer under `src/lib/db/`
- Adapter fallback chain: `bun:sqlite` → `better-sqlite3` → `node:sqlite` (Node ≥22.5) → `sql.js`
- File location: `~/.9router/` or custom `DATA_DIR`
- Per-entity logic: `src/lib/db/repos/*`
- Migrations: `src/lib/db/migrations/`
- Legacy shim: `src/lib/localDb.js` re-exports `src/lib/db/index.js`

### Migration System
- SQLite migrations located in `src/lib/db/migrations/`
- Use existing migration system for schema changes
- Preserve migration ordering conventions
- Create reversible migrations where supported

### API Architecture
- Public API: `/v1/*` endpoints (chat, embeddings, images, etc.)
- Internal API: `/api/providers/*`, `/api/usage/*`, `/api/settings/*`
- OAuth flows in `src/lib/oauth/services/*`
- Provider executors in `open-sse/executors/*`
- Translators in `open-sse/translator/*` (self-register via `import` in index.js)

### Frontend/Backend Boundaries
- Frontend: `src/app/(dashboard)/dashboard/*` (Next.js App Router)
- Backend API: `src/app/api/*` (Next.js API routes)
- Shared components: `src/shared/components/*`, `src/shared/hooks/*`
- Shared constants: `src/shared/constants/*`

### Shared Libraries
- `open-sse/`: Provider-agnostic routing and translation engine
  - `handlers/`: Request processing logic
  - `executors/`: Per-provider upstream call implementations
  - `translator/`: Client ↔ provider format translation
  - `services/`: Service layer utilities
  - `utils/`: Utility functions (proxyFetch, shared.js)
- `cli/`: Command-line launcher and tray management

### Generated Code
- `.next/`: Next.js build output (gitignored)
- `node_modules/`: Dependencies (gitignored)
- `*.rsc`, `*.client-reference-manifest.js`: Generated by Next.js
- Do not manually edit generated files; modify source and regenerate

### Environment Configuration
- Required env: `JWT_SECRET`, `INITIAL_PASSWORD` (must override default `123456`), `API_KEY_SECRET`, `MACHINE_ID_SALT`
- Optional env: `PORT=20128`, `NODE_ENV`, `ENABLE_REQUEST_LOGS`, proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`)
- Example file: `.env.example` (update with secure defaults)
- Secrets stored in `.env` (gitignored)

### CI/CD Configuration
- GitHub Actions in `.github/workflows/`
- Docker builds configured for containerized deployments
- Vercel deployment support (`.vercel/`)

### Deployment Files
- `custom-server.js`: Wraps Next standalone server for IP handling
- `Dockerfile` and `.dockerignore` for container deployments
- Standalone exports: `node_modules/next` included in build output

### Repository Documentation
- `README.md`: Project overview and setup instructions
- `CLAUDE.md`: Project-specific guidance (already present)
- `CHANGELOG.md`: Version history
- `ARCHITECTURE.md`: Full system documentation (read before major changes)
- `open-sse/AGENTS.md`: Routing/translation engine conventions (read before editing `open-sse/`)

**Do not assume architecture based only on filenames.** Always inspect actual code paths.

---

## 4. Task Scope Analysis

Before implementation, explicitly determine the working scope:

### Identify
- **Requested behavior**: What exactly does the user want?
- **Expected outcome**: What should the system look/feel like after completion?
- **Affected features**: Which features will change or be impacted?
- **Related code paths**: Trace the flow from entry point to implementation
- **Relevant modules**: Which files/modules need modification?
- **Affected database objects**: Tables, columns, relationships, constraints
- **Affected APIs**: Routes, request/response formats, authentication requirements
- **Affected user flows**: UI interactions, navigation, permissions
- **Potential regressions**: What might break as a result?
- **Dependencies**: External services, internal modules, third-party libraries
- **Assumptions**: What are you assuming to be true?
- **Constraints**: Technical, business, or policy limitations
- **Validation requirements**: Tests, manual verification, monitoring
- **Compatibility requirements**: Backward compatibility, API contracts
- **Files likely to change**: Primary targets for modification
- **Files that should remain unchanged**: Stable interfaces, generated code

### Distinguish Between
- **Required work**: Must be done to satisfy the requirement
- **Supporting work**: Necessary prerequisites or cleanup
- **Optional improvements**: Nice-to-have but not required
- **Unrelated issues**: Problems outside the scope (record separately if critical)

**Do not expand the scope unnecessarily.** Keep the final diff focused on the task.

---

## 5. Mandatory Task List

Every substantial task **MUST** have a task list that:

- Exists before substantial implementation begins.
- Breaks work into concrete, achievable units.
- Is updated continuously as work progresses.
- Includes implementation and validation tasks.
- Includes discovered follow-up work.
- Clearly represents current progress.
- Contains no hidden or implicit TODOs.

### Example High-Level Task List

```markdown
## Task Plan

- [ ] Inspect current implementation
- [ ] Inspect database schema and migrations
- [ ] Identify affected API/service boundaries
- [ ] Confirm existing implementation patterns
- [ ] Implement required changes
- [ ] Add or update tests
- [ ] Run validation
- [ ] Review database impact
- [ ] Review final diff
- [ ] Reconcile task requirements
- [ ] Commit completed work
```

---

## 6. Detailed Checklist Format

Each meaningful checklist item **MUST** contain:

- Checkbox/status
- Concise title
- Current scope
- Related files
- Related database objects (where applicable)
- Dependencies (where applicable)
- Implementation context
- Validation requirements
- Risks or constraints (where relevant)

### Preferred Format

```markdown
- [ ] **Inspect user persistence flow**
  - Scope:
    - User creation and update flow.
  - Related files:
    - `src/users/service.ts`
    - `src/users/repository.ts`
  - Database:
    - `users`
    - `user_profiles`
  - Dependencies:
    - authentication service
    - transaction helper
  - Validation:
    - verify creation path
    - verify update path
    - verify rollback behavior
  - Notes:
    - Confirm transaction boundaries.
    - Preserve existing validation behavior.
```

For smaller items, unnecessary fields may be omitted, but the checklist must still provide enough context for another agent to understand what remains.

---

## 7. Checklist Lifecycle

The checklist **MUST** remain synchronized with actual work. Agents **MUST**:

- Update status when work progresses.
- Immediately add newly discovered work.
- Split oversized tasks into smaller tasks.
- Mark tasks complete only after implementation and validation.
- Reopen tasks if validation fails.
- Remove tasks only when genuinely irrelevant.
- Document intentionally deferred items.

**Do not keep discovered requirements only in memory.** No required task may remain implicitly tracked.

---

## 8. Sub-Agent Usage

Use sub-agents when parallel exploration improves speed, coverage, or confidence. Useful sub-agent responsibilities include:

- Repository architecture exploration
- Database schema exploration
- Migration history investigation
- API dependency tracing
- Frontend impact analysis
- Backend impact analysis
- Test coverage investigation
- Security review
- Regression-risk exploration
- Dependency research
- Implementation-pattern research
- Final diff review

The main agent remains responsible for:

- Assigning bounded scopes.
- Preventing duplicated exploration.
- Consolidating findings.
- Resolving conflicting conclusions.
- Deciding implementation strategy.
- Maintaining the master task list.
- Validating final work.

---

## 9. Sub-Agent Scope Definition

Every delegated task **SHOULD** have a narrow and explicit scope.

### Good Example

```markdown
Agent: Database Explorer

Goal:
Determine all database objects affected by the requested user-role change.

Inspect:
- schema definitions
- migrations
- foreign keys
- indexes
- triggers
- stored procedures
- application queries

Return:
- affected tables
- affected columns
- relationships
- migration risks
- relevant file paths
- recommended validation
```

### Bad Example

```text
Explore the database.
```

**Avoid vague delegation.** Prefer bounded exploration with explicit expected output.

---

## 10. Database Exploration

Database-related work **MUST** include deliberate database exploration. Inspect where applicable:

- Schema definitions
- Tables and their purpose
- Columns (names, types, defaults, nullable)
- Primary keys
- Foreign keys and referential integrity
- Unique constraints
- Indexes (single-column and composite)
- Check constraints
- Triggers
- Views and materialized views
- Stored procedures/functions
- Row-level security policies
- Generated columns
- Enum types
- Migration history
- ORM models
- Query builders
- Raw SQL queries
- Seeds and fixtures

**Do not modify database behavior without understanding the existing relationships.**

---

## 11. Database Change Safety

Before introducing a schema change, evaluate:

- Backward compatibility with existing applications
- Impact on existing data
- Nullability implications
- Default value changes
- Migration ordering
- Locking implications during migration
- Whether the operation is destructive
- Data migration requirements
- Rollback strategy
- Deployment sequencing (app vs. schema)
- Application/schema compatibility windows
- Index creation cost on large tables
- Foreign-key impact on related records

Agents **MUST avoid destructive database operations** unless explicitly required.

### Examples Requiring Special Care
- Dropping columns or tables
- Renaming columns or tables
- Changing column types (especially narrowing)
- Changing primary keys
- Changing foreign-key behavior (CASCADE, RESTRICT)
- Making nullable columns non-nullable
- Modifying unique constraints
- Deleting production-like data

---

## 12. Migration Rules

When database changes are necessary:

- Use the project's existing migration system (`src/lib/db/migrations/`).
- Inspect recent migrations before creating new ones.
- Preserve migration ordering conventions (timestamps-based).
- Do not modify previously applied migrations unless repository conventions explicitly permit it.
- Create reversible migrations where supported.
- Validate both schema and application expectations.
- Inspect generated SQL if the migration framework makes this possible.

**Migration files MUST be included in the checklist.**

---

## 13. Data Migration Considerations

For changes involving existing records, determine whether data backfilling is required. Consider:

- Missing historical values in old schemas
- Incompatible old values that need normalization
- Duplicate records
- Invalid relationships
- Large-table migration cost (batching requirements)
- Transactional safety (atomicity guarantees)

**Do not assume all existing records satisfy new constraints.**

---

## 14. Existing Pattern Discovery

Before introducing new implementation patterns, search for similar features already implemented in the repository. Look for existing examples of:

- CRUD flows
- Authentication flows
- Authorization checks
- Database transactions
- Input validation
- Error handling patterns
- Logging implementations
- API response formats
- React hooks
- Services and repositories
- Controllers and handlers
- Components (functional, class)
- State management (Context, Redux, etc.)
- Caching strategies
- Unit and integration tests
- Migration patterns

**Reuse established patterns whenever they are appropriate.**

---

## 15. Dependency Analysis

Before changing a module, determine what depends on it. Inspect:

- Import statements (who imports from this module?)
- Export statements (what does this module expose?)
- Interfaces and type definitions
- Service method calls
- Database access patterns
- API consumers (front-end components, other APIs)
- Scheduled jobs
- Background jobs
- Event handlers
- Message queues
- Webhooks
- Tests

**Do not assume a local code change has only local effects.**

---

## 16. API Changes

For API changes, inspect:

- Route definitions and handlers
- Request format (body, query params, headers)
- Response format (status codes, body structure)
- Input validation rules
- Authentication requirements
- Authorization checks
- Error response formats
- HTTP status codes
- Pagination schemes
- Sorting parameters
- Filtering options
- API consumers (front-end components, external services)
- API documentation
- Tests

Agents **SHOULD preserve backward compatibility** unless the task explicitly requires a breaking change.

---

## 17. Frontend Changes

For frontend work, consider:

- Component behavior (rendering, state updates)
- Loading states (spinners, skeletons)
- Empty states (no data scenarios)
- Error states (failure messages, retry options)
- Success states (confirmation feedback)
- Input validation (real-time, on-blur, on-submit)
- Disabled states (interactive vs. static)
- Accessibility (ARIA labels, keyboard navigation)
- Responsive behavior (mobile, tablet, desktop)
- State synchronization (server state vs. client state)
- API failure behavior (graceful degradation)
- Stale data display (caching staleness indicators)
- Navigation (breadcrumb consistency, route transitions)
- Permissions (role-based visibility)
- User feedback (toasts, modals, inline messages)

**Do not validate only the happy path.** Test error scenarios thoroughly.

---

## 18. Backend Changes

For backend work, inspect:

- Input validation (schemas, middleware)
- Authentication mechanisms
- Authorization checks (object-level, tenant boundaries)
- Domain logic correctness
- Database transactions (isolation levels, rollbacks)
- Concurrency considerations (race conditions)
- Idempotency guarantees
- Error handling strategies
- Retry logic (exponential backoff, max retries)
- Logging practices
- External service interactions
- Background job scheduling
- Timeout configurations
- Tests (unit, integration, e2e)

---

## 19. Authentication and Authorization

Any change touching protected resources **MUST** verify:

- Who may perform the action (which roles, which users?)
- How identity is determined (session token, API key, JWT)
- Role/permission checks performed
- Object-level authorization (can this user access this record?)
- Tenant boundaries where applicable (multi-tenancy)
- Admin overrides where applicable (super-admin capabilities)
- Unauthorized behavior (HTTP 401 responses)
- Forbidden behavior (HTTP 403 responses)

**Do not treat authentication as equivalent to authorization.** A user can be authenticated but not authorized.

---

## 20. Security Review

Agents **MUST** consider security implications for relevant changes. Review where applicable:

- SQL injection (parameterized queries)
- Command injection (shell execution safety)
- XSS (input sanitization, content security policy)
- CSRF (tokens, same-site cookies)
- SSRF (URL validation, allowlists)
- Insecure deserialization (trusted sources only)
- Path traversal (file access validation)
- File upload risks (virus scanning, size limits, type validation)
- Authentication bypass (authentication logic gaps)
- Authorization bypass (IDOR vulnerabilities)
- Privilege escalation (role manipulation)
- Exposed secrets (environment variable leakage)
- Sensitive logging (PII, credentials in logs)
- Insecure redirects (open redirect vulnerabilities)
- Unsafe HTML rendering (DOM-based XSS)
- Rate limiting (brute-force protection)
- Brute-force exposure (account lockout)

**Security findings related to the task MUST be added to the checklist.**

---

## 21. Secrets and Credentials

Agents **MUST NOT**:

- Hard-code secrets in source files
- Commit passwords to version control
- Commit API keys to version control
- Commit private tokens to version control
- Commit private certificates to version control
- Expose credentials in log files
- Expose `.env` contents unnecessarily

When configuration is needed, follow existing environment-variable and secret-management conventions. Store secrets in `.env` (gitignored) and reference via `process.env.*`.

---

## 22. Environment Configuration

When introducing configuration:

- Inspect existing environment conventions (`.env.example`)
- Update example configuration where appropriate
- Document required variables in README or comments
- Define sensible defaults only when safe
- Fail clearly when required configuration is missing (exit with error message)

**Do not silently rely on undocumented environment variables.**

---

## 23. External Services

When code interacts with external services, inspect:

- Authentication requirements (API keys, OAuth, mTLS)
- Rate limits (requests per second/minute/hour)
- Timeout behavior (connection timeout, read timeout)
- Retry strategy (exponential backoff, jitter)
- Idempotency guarantees (duplicate request handling)
- Error response formats (structure, semantics)
- Partial failures (partial success scenarios)
- Availability assumptions (SLA, downtime window)
- Mock/test strategy (mocks, stubs, fixtures)

**Avoid tests that require live third-party services** unless the repository explicitly uses them and mocks are unavailable.

---

## 24. Error Handling

New behavior **MUST** follow repository error-handling conventions. Consider:

- Expected errors (validation failures, not-found)
- Unexpected errors (system failures, exceptions)
- Validation errors (structured format, field-level details)
- Database failures (connection lost, deadlock, constraint violation)
- External API failures (timeout, invalid response, 5xx)
- Retryable failures (network transient, rate limit)
- Authorization failures (permission denied, role mismatch)
- User-visible messages (friendly, actionable)
- Internal diagnostic details (logs, stack traces)

**Do not swallow exceptions without justification.** Log errors with sufficient context for debugging.

---

## 25. Logging and Observability

For operationally significant changes, consider whether logging, metrics, or tracing need updates. Logs **SHOULD**:

- Provide actionable context (request ID, user ID, operation name)
- Avoid leaking sensitive information (PII, credentials)
- Follow established logging conventions (JSON vs. plain text)
- Avoid unnecessary noise (debug chatter in production)

Consider adding instrumentation points for metrics (latency, error rates, throughput).

---

## 26. Performance

Evaluate performance when changes affect:

- Database queries (N+1 problems, missing indexes)
- Loops over large collections (O(n²) patterns)
- N+1 query risks (lazy loading arrays)
- Expensive API calls (rate-limit implications)
- Repeated rendering (React memoization opportunities)
- Serialization/deserialization (large JSON payloads)
- Caching strategies (cache invalidation, TTL)
- Background processing (queue depth, worker scaling)
- Large file operations (streaming vs. buffering)

For database queries, inspect whether relevant indexes exist. Avoid premature optimization, but do not introduce obvious regressions.

---

## 27. Concurrency and Transactions

When multiple operations must succeed together, inspect transaction requirements. Consider:

- Race conditions (concurrent updates to same record)
- Duplicate requests (idempotency keys)
- Simultaneous updates (lock escalation)
- Transaction boundaries (all-or-nothing semantics)
- Locks (row-level, table-level, advisory)
- Optimistic concurrency (version numbers, conflict detection)
- Idempotency (same input produces same output)

**Do not assume requests occur sequentially.** Handle concurrent access patterns correctly.

---

## 28. Testing Requirements

Every implementation **SHOULD** include or update appropriate tests. Consider:

- Unit tests (isolated function/component tests)
- Integration tests (service + database/API combinations)
- Database tests (schema validity, constraint enforcement)
- API tests (request/response validation)
- Component tests (React component rendering, interaction)
- End-to-end tests (full user flow simulation)

Tests **SHOULD** cover:

- Happy path (expected successful scenario)
- Invalid input (bad data, malformed requests)
- Edge cases (empty strings, zero values, null, undefined)
- Authorization failures (wrong permissions, unauthorized)
- Not-found cases (missing records, deleted entities)
- Conflict cases (unique constraint violations)
- Relevant error behavior (graceful degradation, error messages)

---

## 29. Regression Tests

For bug fixes, add a regression test whenever practical. The regression test **SHOULD**:

1. Fail against the broken behavior (prove defect exists).
2. Pass after the fix (prove resolution works).
3. Clearly represent the original defect (named appropriately).

Example: `test/user-validation-rejects-invalid-email-format.js`

---

## 30. Test Integrity

Agents **MUST NOT** make tests pass by weakening meaningful assertions. Do not:

- Delete failing tests simply to obtain a green test suite
- Replace strong assertions with meaningless ones
- Disable tests without documented justification
- Mock away the behavior being tested

When an existing test genuinely needs modification, explain why in the checklist.

---

## 31. Validation Commands

Before completion, run relevant project validation commands. Use the repository's actual commands:

```bash
# Testing
npm test                    # Run test suite
npx vitest run            # Run vitest tests
npx vitest run <file>     # Run specific test file

# Linting
npx eslint .              # Run ESLint

# Build
npm run build             # Build production bundle
npm run dev               # Start development server

# Database
npx prisma db push        # Push schema changes (if using Prisma)
# For SQLite migrations: src/lib/db/migrations/apply.js

# Integration Tests
npm run test:integration  # Run integration tests (if configured)
```

**Use the repository's actual commands rather than assuming command names.**

---

## 32. Incremental Validation

Do not wait until the very end to validate large changes. Validate incrementally after meaningful implementation steps. Examples:

- Run focused tests after modifying a service
- Run type checking after changing interfaces
- Validate migrations after schema changes
- Run related UI tests after component changes

Incremental validation catches issues early and reduces debugging complexity.

---

## 33. Build Validation

If the project has a build step, ensure the affected project still builds successfully unless environmental limitations prevent it. Build failures related to the task **MUST** be resolved before completion.

Run:
```bash
npm run build
```

And confirm no build errors or warnings appear.

---

## 34. Formatting and Linting

Follow existing repository formatting and linting rules. Do not introduce unrelated formatting changes across the repository. Keep diffs focused.

Pre-commit check:
```bash
npx eslint . --fix      # Auto-fix linting issues
npx eslint .            # Verify no remaining issues
```

---

## 35. Type Safety

For typed projects (not this one—plain JavaScript):

- Preserve type safety (avoid unnecessary `any` types)
- Avoid unsafe casts (type assertions without validation)
- Update shared types where required (interface consistency)
- Ensure API/database models remain aligned (contract matching)

Do not silence type errors without understanding them.

---

## 36. Generated Files

Identify generated files before editing them. Agents **SHOULD NOT** manually edit generated files unless repository conventions explicitly require it. Instead:

- Modify the source files
- Regenerate output using the appropriate tooling
- Commit both source and generated files

Examples of generated files in this repo:
- `.next/` directory (Next.js build output)
- `*_client-reference-manifest.js` (Next.js internal)
- `__snapshots__/*` (Vitest snapshots - acceptable to commit)

---

## 37. Dependency Changes

Adding or upgrading dependencies requires justification. Before introducing a new dependency, determine whether:

- Existing dependencies already solve the problem
- Native functionality is sufficient
- Maintenance burden is justified
- Security/licensing concerns exist
- Bundle/runtime impact is acceptable

Update lockfiles (`package-lock.json`, `bun.lock`) when required. Do not perform unrelated dependency upgrades.

---

## 38. Backward Compatibility

Unless explicitly requested otherwise, preserve compatibility with:

- Existing API consumers (front-end components, external services)
- Stored data (database schema, serialization formats)
- Database schema expectations (column names, types)
- Configuration (environment variable names)
- Serialized formats (JSON structures, message formats)
- Public interfaces (exported functions, classes)

Breaking changes **MUST** be explicitly recognized in the task checklist and justified.

---

## 39. Scope Discipline

Agents **MUST avoid opportunistic refactors** unrelated to the task. If unrelated issues are discovered:

- Do not silently expand the implementation
- Record them separately if relevant (new task item)
- Fix them only when required for the requested work

Keep the final diff focused on the task.

---

## 40. Existing User Changes

Before editing files, inspect current Git status. Agents **MUST** preserve unrelated user or developer changes already present in the working tree. Do not:

- Overwrite unrelated modifications
- Revert changes that were not created by the agent
- Reset the repository destructively
- Discard untracked files

Check:
```bash
git status
```

---

## 41. Git Safety

Avoid destructive Git operations unless explicitly required. Do not use commands such as:

```bash
git reset --hard
git clean -fd
git checkout -- .
```

without explicit justification and authorization. Prefer targeted, reversible changes.

---

## 42. Branch Awareness

Before committing, identify the current branch and repository state. Do not unexpectedly create, switch, merge, rebase, or delete branches unless needed by the task or explicitly requested.

Check:
```bash
git branch --show-current
git log --oneline -3
```

---

## 43. Commit Requirement

Every completed task **MUST** end with a Git commit. Before committing:

- Verify Git status (`git status`)
- Inspect the diff (`git diff --cached`)
- Ensure relevant files are included
- Ensure unrelated changes are excluded
- Run relevant validation (tests, lint, build)
- Confirm checklist completion

Do not leave completed agent work uncommitted unless explicitly instructed otherwise.

---

## 44. Commit Scope

Commits **SHOULD** contain only changes associated with the current task. Do not include unrelated user changes. If the working tree already contains unrelated modifications, stage only relevant files or hunks:

```bash
git add <specific-files>
# OR
git add -p                # Interactive staging
```

---

## 45. Commit Message

Use a clear, descriptive commit message. Prefer repository conventions when they exist (Conventional Commits).

### Examples

```bash
feat: add qoder activity quota fetching with combined credits

- Fetch user credits from /api/v2/quota/usage endpoint
- Fetch activity quotas from /algo/api/v2/activity endpoint
- Merge both quota sources into unified response
- Handle COSY-signed requests for activity API

Closes #1234
```

```bash
fix(qoder): resolve combinedQuotas reference error

- Declare combinedQuotas at function start
- Move variable declaration before first usage
- Prevent runtime ReferenceError in getQoderUsage

Fixes #5678
```

```bash
refactor(auth): centralize OAuth credential retrieval

- Extract OAuth client lookup to dedicated utility
- Reduce duplication across authentication flows
- Preserve existing behavior and error handling
```

The commit message should describe the completed outcome rather than the process used to achieve it.

---

## 46. Do Not Push Automatically

Committing is mandatory after task completion. Pushing to a remote repository **MUST NOT** occur unless explicitly requested or repository-specific instructions require it.

---

## 47. Final Diff Review

Before marking work complete, review the final diff line by line where practical. Look for:

- Accidental modifications (unrelated files changed)
- Debug code (console.log, debugger statements)
- Dead code (unused functions, unreachable branches)
- Commented-out code (should be removed or committed properly)
- Temporary logging (verbose output not meant for production)
- TODO markers (unresolved task items)
- Secrets (credentials, API keys accidentally exposed)
- Formatting noise (unrelated whitespace changes)
- Duplicate logic (copy-paste code that could be factored)
- Missing error handling (unhandled promises, missing try-catch)
- Missing tests (uncovered code paths)
- Incomplete renames (old imports still present)
- Stale imports (imports no longer used)
- Unexpected generated files (files that should be regenerated)

---

## 48. Debug Artifact Cleanup

Before completion, remove temporary artifacts such as:

- Debug prints (`console.log`, `debugger`)
- Temporary console logs (verbose output)
- Experimental scripts (scratch pad files)
- Scratch files (temporary test files)
- Temporary comments (notes about experiments)
- Debugging breakpoints (`process breakpoints()`)
- Generated test files that should not be committed

Ensure production code is clean before committing.

---

## 49. TODO/FIXME Review

Search changed code for newly introduced:

```javascript
TODO
FIXME
HACK
XXX
// @ts-ignore
```

Task-scoped unresolved markers **MUST** either be resolved or explicitly documented. Do not use TODO comments as a substitute for completing required work.

---

## 50. Documentation

Update documentation when behavior, configuration, setup, database structure, API contracts, or developer workflows change. Potential documentation includes:

- README (project overview, quick start)
- API docs (endpoint descriptions, examples)
- Schema docs (database table descriptions)
- Environment examples (`.env.example` updates)
- Comments (inline documentation in code)
- Architecture docs (`ARCHITECTURE.md`, design decisions)
- Migration notes (migration rationales)
- Developer setup instructions (local development guide)

---

## 51. Comment Quality

Code comments **SHOULD** explain:

- Why something is necessary (rationale for non-obvious choices)
- Non-obvious constraints (external dependencies, edge cases)
- Unusual behavior (deviations from standards)
- External requirements (protocol specifications, API contracts)

Avoid comments that simply restate obvious code. Comments should answer "why" not "what".

---

## 52. Edge Case Review

Before completion, deliberately inspect relevant edge cases. Examples:

- Empty input (empty strings, empty arrays, empty objects)
- Null values (explicit null inputs)
- Missing records (foreign key references to nonexistent entities)
- Duplicate records (unique constraint scenarios)
- Zero values (zero amounts, zero quantities)
- Negative values (negative numbers in contexts requiring positivity)
- Very large values (integer overflow, precision loss)
- Expired data (expired tokens, expired subscriptions)
- Unauthorized users (access attempts with insufficient permissions)
- Concurrent updates (two agents editing same record simultaneously)
- Repeated requests (duplicate API calls, idempotency checks)
- Network failure (API timeouts, connection resets)
- Partial database state (failed transaction with partial writes)

Test each edge case mentally and verify adequate handling.

---

## 53. Failure Scenario Review

Ask:

- What happens if this operation fails halfway?
- What happens if the database is unavailable?
- What happens if the external service times out?
- What happens if the user retries the same action?
- What happens if two requests execute simultaneously?
- What happens if the expected record does not exist?

Add relevant findings to the checklist. Consider adding fallback behavior, graceful degradation, or clearer error messages.

---

## 54. Requirement Traceability

Before finishing, map every original user requirement to:

- Implementation (where was it implemented?)
- Affected files (which files changed?)
- Validation evidence (how was it tested?)

No requirement should disappear during implementation.

### Example

```markdown
## Requirement Reconciliation

- [x] Prevent duplicate memberships
  - Implemented:
    - `src/memberships/service.ts`
  - Validated:
    - integration test added

- [x] Return conflict response
  - Implemented:
    - `src/api/memberships.ts`
  - Validated:
    - API test verifies HTTP 409
```

---

## 55. Discovery Tracking

If implementation reveals additional necessary work, immediately add it to the checklist. Examples:

```markdown
- [ ] Add missing index discovered during query review
- [ ] Update authorization test discovered while tracing endpoint
- [ ] Update environment documentation for new variable
```

No discovered required work should remain implicit.

---

## 56. Blocked Work

If an item cannot be completed because of an external constraint:

- Mark it clearly as blocked
- Explain why it is blocked
- Document what was attempted
- Identify what is needed to unblock it
- Do not falsely mark it complete

### Example

```markdown
- [BLOCKED] **Validate production OAuth callback**
  - Reason:
    - Production credentials are unavailable locally.
  - Completed:
    - Local callback behavior verified
    - Unit tests pass
  - Remaining:
    - Verify production provider configuration
  - Blocker:
    - Requires access to production OAuth credentials
```

---

## 57. Definition of Done

A task is considered complete only when all applicable conditions below are satisfied:

- [ ] Original request has been fully addressed.
- [ ] Repository context was inspected.
- [ ] Relevant architecture was understood.
- [ ] Task checklist exists.
- [ ] All required checklist items are resolved.
- [ ] Relevant database objects were reviewed.
- [ ] Database migrations were validated where applicable.
- [ ] Existing implementation patterns were reviewed.
- [ ] Dependencies and consumers were considered.
- [ ] Security implications were considered.
- [ ] Edge cases were considered.
- [ ] Error paths were considered.
- [ ] Tests were added or updated where appropriate.
- [ ] Relevant tests pass.
- [ ] Lint passes where applicable.
- [ ] Type checking passes where applicable.
- [ ] Build succeeds where applicable.
- [ ] Documentation was updated where required.
- [ ] No unintended debug artifacts remain.
- [ ] No required task-scoped TODO remains.
- [ ] Final diff was reviewed.
- [ ] Requirement reconciliation was performed.
- [ ] Git status was inspected.
- [ ] Only relevant changes were staged.
- [ ] Completed work was committed.

A task **MUST NOT** be described as complete if any required item remains unresolved.

---

## 58. Final Completion Report

After completing and committing the work, provide a concise completion report. Include:

```markdown
## Completed

### Changes
- Summary of implemented changes (bullet points)

### Files
- Important files changed (with brief rationale)

### Database
- Schema/migration/query changes, if any

### Validation
- Tests run (test names, results)
- Lint/typecheck/build results

### Checklist
- All required task items completed
- Or explicitly documented blocked items

### Commit
- `<commit hash>` `<commit message>`

### Notes
- Important assumptions, limitations, or follow-up information
```

### Example

```markdown
## Completed

### Changes
- Modified `getQoderUsage()` to fetch both user credits and activity quotas
- Added `combinedQuotas` object at function start to avoid ReferenceError
- Updated QODER_ACTIVITY_URL constant definition

### Files
- `open-sse/services/usage/misc.js` - Core quota fetching logic

### Database
- No database changes required

### Validation
- Node syntax check passed: `node --check open-sse/services/usage/misc.js`
- No lint errors reported
- Manual testing: quota data displays correctly for connected accounts

### Checklist
- All required task items completed

### Commit
- `fa477768` fix(qoder): return available quotas even if activity API fails, show user credits

### Notes
- Activity API currently returns 403 Forbidden due to COSY signing requirements
- User credits (300 total) are displayed successfully
- Activity quotas (800 free calls) require full COSY implementation to retrieve
```

---

## 59. Mandatory Final Self-Review

Immediately before committing, the agent **MUST** ask itself:

- Did I implement every requirement?
- Did I accidentally leave anything unfinished?
- Did I add newly discovered tasks to the checklist?
- Did I inspect relevant database behavior?
- Did I consider dependent code paths?
- Did I test the failure paths that matter?
- Did I preserve unrelated existing changes?
- Did I introduce unnecessary complexity?
- Did I introduce a dependency unnecessarily?
- Did I leave debug artifacts?
- Did I review the final diff?
- Can I point to validation evidence for each important behavior?

**If any answer exposes missing work, return to implementation before committing.**

---

## 60. Golden Rule

> **Never rely on memory to track unfinished work.**
> If something needs to be investigated, implemented, validated, reviewed, or documented, put it in the checklist.

> **Never mark a task complete merely because the main code path works.** Completion requires implementation, validation, reconciliation, final review, and commit.

---

## Appendix: Quick Reference

### Common Commands

```bash
# Inspect repository state
git status
git log --oneline -10
git diff HEAD

# Run tests
npm test
npx vitest run

# Linting
npx eslint . --fix

# Build
npm run build

# Start development
npm run dev
```

### Checklist Template

```markdown
## Task Plan

- [ ] **Title: Brief description of task**
  - Scope:
    - Specific area affected
  - Related files:
    - `path/to/file.js`
  - Database:
    - Tables/columns affected
  - Dependencies:
    - Other services/modules
  - Validation:
    - Tests to run
    - Manual verification steps
  - Notes:
    - Constraints, risks, assumptions
```

### Security Checklist Items

- [ ] Verify authentication requirements
- [ ] Verify authorization checks
- [ ] Check for SQL injection vulnerabilities
- [ ] Check for XSS vulnerabilities
- [ ] Check for CSRF protections
- [ ] Verify no secrets hardcoded
- [ ] Verify input sanitization
- [ ] Verify error message safety (no info leakage)

### Database Checklist Items

- [ ] Schema inspected
- [ ] Migrations identified
- [ ] Foreign keys verified
- [ ] Indexes considered
- [ ] Default values checked
- [ ] Nullability implications assessed
- [ ] Backward compatibility evaluated
- [ ] Rollback strategy planned
```

---

**This document is mandatory reading for all agents working on this repository. Violations of these principles may result in rejected PRs or rollback of commits.**

**Last updated:** 2026-08-10  
**Version:** 1.0.0
