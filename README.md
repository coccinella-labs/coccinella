<p align="center">
  <img src="https://raw.githubusercontent.com/Coccinella-Labs/coccinella/main/.github/assets/thumbnail.png" alt="coccinella" width="100%">
</p>

<!-- SPDX-License-Identifier: LicenseRef-DIFF -->

# DIFF

DIFF is a focused interface for reading pull requests without the surrounding noise that usually comes with hosted forge UIs. It pulls live repository data from GitHub, renders diffs and review history in a denser workspace, and keeps discussion, checks, and timeline state close to the code that matters. The product is deliberately work-first: a resizable navigation panel on the left, a single review surface on the right, and minimal chrome around the core review flow.

The application is built as a React frontend with Tailwind-driven styling and a small Node server that brokers GitHub API access. Supabase-backed auth and saved user state are also supported, with GitHub-backed sign-in used for authenticated review actions.

Authenticated GitHub writes require the GitHub OAuth App to be authorized by the signed-in user, and organization-owned repositories may also require that organization's OAuth App access approval.

Setup and operational detail live in dedicated docs:

- [docs/auth/supabase-github.md](docs/auth/supabase-github.md) for Supabase and GitHub OAuth configuration
- [supabase/migrations/20260508_create_user_preferences.sql](supabase/migrations/20260508_create_user_preferences.sql), [supabase/migrations/20260508_extend_user_preferences_saved_state.sql](supabase/migrations/20260508_extend_user_preferences_saved_state.sql), and [supabase/migrations/20260509_extend_user_preferences_graphite_theme.sql](supabase/migrations/20260509_extend_user_preferences_graphite_theme.sql) for the backing preference schema
- [.codex/README.md](.codex/README.md) for repo-local release and workflow notes

For authenticated local verification, the browser-side e2e flow is also documented in [docs/auth/supabase-github.md](docs/auth/supabase-github.md), including how to seed a real Supabase session into `npm run check:e2e`.

DIFF is a specialized browser-based code review tool and is not an official product of any repository owner whose data it reads. Users are responsible for their own environment configuration and any sensitive credentials used during local development.
