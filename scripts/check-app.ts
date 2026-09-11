// SPDX-License-Identifier: LicenseRef-DIFF

import "dotenv/config";

type CheckStatus = "pass" | "warn" | "fail" | "skip";

interface CheckResult {
  name: string;
  status: CheckStatus;
  durationMs: number;
  detail: string;
}

interface RepoInfo {
  default_branch?: string;
  html_url?: string;
}

interface PullRequestSummary {
  number: number;
  title: string;
  base?: { ref?: string };
  head?: { ref?: string };
}

interface PullFileSummary {
  filename?: string;
  patch?: string | null;
}

interface ChecksPayload {
  total_count?: number;
  check_runs?: Array<{ id?: number; conclusion?: string | null; status?: string | null }>;
  mergeable?: boolean | null;
  merge_state_status?: string | null;
}

interface CheckRunDetails {
  id?: number;
  steps?: Array<{ name?: string; status?: string; conclusion?: string | null }>;
  job_id?: number | null;
  html_url?: string;
}

const BASE_URL = process.env.DIFF_BASE_URL || "http://localhost:3000";
const DEFAULT_OWNER = process.env.GITHUB_REPO_OWNER || "coccinella-labs";
const DEFAULT_REPO = process.env.GITHUB_REPO_NAME || "harper";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_ACCESS_TOKEN = process.env.DIFF_SUPABASE_ACCESS_TOKEN;
const GITHUB_PROVIDER_TOKEN = process.env.DIFF_GITHUB_PROVIDER_TOKEN;
const WRITE_COMMENT_BODY = process.env.DIFF_POST_COMMENT_BODY;
const WRITE_COMMENT_PR_NUMBER = process.env.DIFF_POST_COMMENT_PR_NUMBER;
const REQUIRE_AUTH_CHECKS = process.env.DIFF_REQUIRE_AUTH_CHECKS === "1";
const SAMPLE_COUNT = Math.max(1, Number(process.env.DIFF_SAMPLE_COUNT || "3"));

const results: CheckResult[] = [];

const record = (result: CheckResult) => {
  results.push(result);
};

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const formatMs = (durationMs: number) => `${durationMs.toFixed(0)}ms`;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

async function timedJsonCheck<T>(
  name: string,
  url: string,
  options: RequestInit = {},
  expectedStatuses: number[] = [200],
  warnAfterMs = 1800,
): Promise<T | null> {
  const started = nowMs();

  try {
    const response = await fetch(url, options);
    const durationMs = nowMs() - started;
    const text = await response.text();

    if (!expectedStatuses.includes(response.status)) {
      record({
        name,
        status: "fail",
        durationMs,
        detail: `HTTP ${response.status}${text ? `: ${text.slice(0, 140)}` : ""}`,
      });
      return null;
    }

    let json: T | null = null;
    if (text) {
      try {
        json = JSON.parse(text) as T;
      } catch (error) {
        record({
          name,
          status: "fail",
          durationMs,
          detail: error instanceof Error ? `invalid JSON: ${error.message}` : "invalid JSON",
        });
        return null;
      }
    }

    record({
      name,
      status: durationMs > warnAfterMs ? "warn" : "pass",
      durationMs,
      detail: durationMs > warnAfterMs ? `slow response (${formatMs(durationMs)})` : "ok",
    });

    return json;
  } catch (error) {
    const durationMs = nowMs() - started;
    record({
      name,
      status: "fail",
      durationMs,
      detail: error instanceof Error ? error.message : "unknown error",
    });
    return null;
  }
}

async function timedTextCheck(
  name: string,
  url: string,
  options: RequestInit = {},
  expectedStatuses: number[] = [200],
  warnAfterMs = 1200,
): Promise<string | null> {
  const started = nowMs();

  try {
    const response = await fetch(url, options);
    const durationMs = nowMs() - started;
    const text = await response.text();

    if (!expectedStatuses.includes(response.status)) {
      record({
        name,
        status: "fail",
        durationMs,
        detail: `HTTP ${response.status}${text ? `: ${text.slice(0, 140)}` : ""}`,
      });
      return null;
    }

    record({
      name,
      status: durationMs > warnAfterMs ? "warn" : "pass",
      durationMs,
      detail: durationMs > warnAfterMs ? `slow response (${formatMs(durationMs)})` : "ok",
    });

    return text;
  } catch (error) {
    const durationMs = nowMs() - started;
    record({
      name,
      status: "fail",
      durationMs,
      detail: error instanceof Error ? error.message : "unknown error",
    });
    return null;
  }
}

function assertCondition(name: string, condition: boolean, detail: string) {
  record({
    name,
    status: condition ? "pass" : "fail",
    durationMs: 0,
    detail,
  });
}

async function sampleRoute(
  name: string,
  url: string,
  options: RequestInit = {},
  expectedStatuses: number[] = [200],
  warnAverageMs = 1400,
) {
  const durations: number[] = [];

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const started = nowMs();
    try {
      const response = await fetch(url, options);
      const durationMs = nowMs() - started;
      durations.push(durationMs);

      if (!expectedStatuses.includes(response.status)) {
        const text = await response.text();
        record({
          name,
          status: "fail",
          durationMs,
          detail: `sample ${index + 1}/${SAMPLE_COUNT} HTTP ${response.status}${text ? `: ${text.slice(0, 140)}` : ""}`,
        });
        return;
      }

      await response.arrayBuffer();
    } catch (error) {
      const durationMs = nowMs() - started;
      record({
        name,
        status: "fail",
        durationMs,
        detail: error instanceof Error ? error.message : "unknown error",
      });
      return;
    }
  }

  const averageMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const maxMs = Math.max(...durations);
  record({
    name,
    status: averageMs > warnAverageMs ? "warn" : "pass",
    durationMs: averageMs,
    detail: `avg ${formatMs(averageMs)}, max ${formatMs(maxMs)} across ${SAMPLE_COUNT} samples`,
  });
}

async function checkSupabasePreferences() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    record({
      name: "supabase-env",
      status: "skip",
      durationMs: 0,
      detail: "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set",
    });
    return;
  }

  record({
    name: "supabase-env",
    status: "pass",
    durationMs: 0,
    detail: "frontend env present",
  });

  if (!SUPABASE_ACCESS_TOKEN) {
    record({
      name: "supabase-preferences",
      status: REQUIRE_AUTH_CHECKS ? "fail" : "pass",
      durationMs: 0,
      detail: REQUIRE_AUTH_CHECKS
        ? "DIFF_SUPABASE_ACCESS_TOKEN is required when DIFF_REQUIRE_AUTH_CHECKS=1"
        : "optional authenticated preference check not configured",
    });
    return;
  }

  const response = await timedJsonCheck<unknown[]>(
    "supabase-preferences",
    `${SUPABASE_URL}/rest/v1/user_preferences?select=user_id,theme,default_repo_owner,default_repo_name,recent_repos,saved_pulls&limit=1`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
      },
    },
    [200],
    1400,
  );

  assertCondition(
    "supabase-preferences-shape",
    Array.isArray(response),
    "user_preferences REST response shape",
  );
}

async function checkWritePath(owner: string, repo: string, pullNumber: number) {
  if (!SUPABASE_ACCESS_TOKEN || !GITHUB_PROVIDER_TOKEN) {
    record({
      name: "write-route",
      status: REQUIRE_AUTH_CHECKS ? "fail" : "pass",
      durationMs: 0,
      detail: REQUIRE_AUTH_CHECKS
        ? "DIFF_SUPABASE_ACCESS_TOKEN and DIFF_GITHUB_PROVIDER_TOKEN are required when DIFF_REQUIRE_AUTH_CHECKS=1"
        : "optional authenticated write check not configured",
    });
    return;
  }

  if (WRITE_COMMENT_BODY && WRITE_COMMENT_PR_NUMBER) {
    const liveWrite = await timedJsonCheck<unknown>(
      "write-comment-live",
      `${BASE_URL}/api/pulls/${WRITE_COMMENT_PR_NUMBER}/comments?owner=${owner}&repo=${repo}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
          "X-GitHub-Provider-Token": GITHUB_PROVIDER_TOKEN,
        },
        body: JSON.stringify({ body: WRITE_COMMENT_BODY }),
      },
      [201],
      2200,
    );

    assertCondition(
      "write-comment-live-shape",
      isObject(liveWrite) && typeof liveWrite.id === "number",
      "live comment publish returned GitHub comment payload",
    );
    return;
  }

  await timedJsonCheck(
    "write-route",
    `${BASE_URL}/api/pulls/${pullNumber}/comments?owner=${owner}&repo=${repo}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        "X-GitHub-Provider-Token": GITHUB_PROVIDER_TOKEN,
      },
      body: JSON.stringify({ body: "" }),
    },
    [400],
    1800,
  );
}

async function main() {
  const shellHtml = await timedTextCheck("shell", `${BASE_URL}/`);
  assertCondition(
    "shell-content",
    typeof shellHtml === "string" && shellHtml.includes("DIFF"),
    "app shell rendered",
  );

  const repoInfo = await timedJsonCheck<RepoInfo>("repo", `${BASE_URL}/api/repo`);
  assertCondition(
    "repo-shape",
    !!repoInfo?.default_branch && !!repoInfo?.html_url,
    "repo payload includes default branch and html url",
  );

  const pulls = await timedJsonCheck<PullRequestSummary[]>(
    "pulls",
    `${BASE_URL}/api/pulls?state=open&page=1&per_page=5`,
    {},
    [200],
    2400,
  );

  assertCondition(
    "pulls-shape",
    Array.isArray(pulls),
    "pulls route returned an array",
  );

  const firstPull = pulls?.[0];
  if (!firstPull) {
    record({
      name: "pull-details",
      status: "skip",
      durationMs: 0,
      detail: "no open pulls returned",
    });
  } else {
    const owner = DEFAULT_OWNER;
    const repo = DEFAULT_REPO;
    const pullBase = `${BASE_URL}/api/pulls/${firstPull.number}`;
    const compareBase = firstPull.base?.ref || repoInfo?.default_branch;
    const compareHead = firstPull.head?.ref;

    const [
      diffText,
      files,
      comments,
      reviewComments,
      checks,
      commits,
      reviews,
      timeline,
      edits,
    ] = await Promise.all([
      timedTextCheck("pull-diff", `${pullBase}/diff?owner=${owner}&repo=${repo}`, {}, [200], 2600),
      timedJsonCheck<PullFileSummary[]>("pull-files", `${pullBase}/files?owner=${owner}&repo=${repo}`, {}, [200], 2600),
      timedJsonCheck<unknown[]>("pull-comments", `${pullBase}/comments?owner=${owner}&repo=${repo}`, {}, [200], 1800),
      timedJsonCheck<unknown[]>("pull-review-comments", `${pullBase}/review-comments?owner=${owner}&repo=${repo}`, {}, [200], 1800),
      timedJsonCheck<ChecksPayload>("pull-checks", `${pullBase}/checks?owner=${owner}&repo=${repo}`, {}, [200], 2600),
      timedJsonCheck<unknown[]>("pull-commits", `${pullBase}/commits?owner=${owner}&repo=${repo}`, {}, [200], 2200),
      timedJsonCheck<unknown[]>("pull-reviews", `${pullBase}/reviews?owner=${owner}&repo=${repo}`, {}, [200], 1800),
      timedJsonCheck<unknown[]>("pull-timeline", `${pullBase}/timeline?owner=${owner}&repo=${repo}`, {}, [200], 2400),
      timedJsonCheck<unknown[]>("pull-edits", `${pullBase}/edits?owner=${owner}&repo=${repo}`, {}, [200], 2400),
    ]);

    assertCondition(
      "pull-diff-content",
      typeof diffText === "string" && diffText.includes("diff --git"),
      "diff route returned unified diff content",
    );
    assertCondition(
      "pull-files-shape",
      Array.isArray(files) && files.length > 0,
      "files route returned at least one changed file",
    );
    assertCondition(
      "pull-comments-shape",
      Array.isArray(comments),
      "issue comments route returned an array",
    );
    assertCondition(
      "pull-review-comments-shape",
      Array.isArray(reviewComments),
      "review comments route returned an array",
    );
    assertCondition(
      "pull-commits-shape",
      Array.isArray(commits) && commits.length > 0,
      "commits route returned at least one commit",
    );
    assertCondition(
      "pull-reviews-shape",
      Array.isArray(reviews),
      "reviews route returned an array",
    );
    assertCondition(
      "pull-timeline-shape",
      Array.isArray(timeline),
      "timeline route returned an array",
    );
    assertCondition(
      "pull-edits-shape",
      Array.isArray(edits),
      "edits route returned an array",
    );
    assertCondition(
      "pull-checks-shape",
      isObject(checks) &&
        Array.isArray(checks.check_runs) &&
        "mergeable" in checks &&
        "merge_state_status" in checks,
      "checks payload includes merged check runs and merge state",
    );

    if (checks?.check_runs?.length) {
      const checkRunIds = checks.check_runs
        .map((run) => run.id)
        .filter((id): id is number => typeof id === "number");
      const firstCheckRunId = checkRunIds[0];

      if (firstCheckRunId) {
        const checkDetail = await timedJsonCheck<CheckRunDetails>(
          "check-run-detail",
          `${BASE_URL}/api/checks/${firstCheckRunId}?owner=${owner}&repo=${repo}`,
          {},
          [200],
          2200,
        );

        assertCondition(
          "check-run-detail-shape",
          isObject(checkDetail) && Array.isArray(checkDetail.steps),
          "check-run detail includes step list",
        );

        const logCapableCheckDetails: CheckRunDetails[] = [];
        if (typeof checkDetail?.job_id === "number") {
          logCapableCheckDetails.push(checkDetail);
        }

        for (const checkRunId of checkRunIds.slice(1, 10)) {
          try {
            const response = await fetch(
              `${BASE_URL}/api/checks/${checkRunId}?owner=${owner}&repo=${repo}`,
            );
            if (!response.ok) continue;
            const candidate = (await response.json()) as CheckRunDetails;
            if (typeof candidate.job_id === "number") {
              logCapableCheckDetails.push(candidate);
            }
          } catch {
            // Keep checking other runs; the detail endpoint is already covered above.
          }
        }

        if (logCapableCheckDetails.length > 0) {
          if (logCapableCheckDetails[0] !== checkDetail) {
            record({
              name: "check-run-log-target",
              status: "pass",
              durationMs: 0,
              detail: `found actions job ${logCapableCheckDetails[0].job_id} in additional check runs`,
            });
          }

          let logsChecked = false;
          let logsUnavailable = 0;
          for (const detail of logCapableCheckDetails) {
            if (typeof detail.job_id !== "number") continue;

            const started = nowMs();
            const response = await fetch(
              `${BASE_URL}/api/checks/${detail.job_id}/logs?owner=${owner}&repo=${repo}`,
            );
            const durationMs = nowMs() - started;

            if (response.status === 404) {
              logsUnavailable += 1;
              continue;
            }

            const logsText = await response.text();
            if (!response.ok) {
              record({
                name: "check-run-logs",
                status: "fail",
                durationMs,
                detail: `HTTP ${response.status}${logsText ? `: ${logsText.slice(0, 140)}` : ""}`,
              });
              logsChecked = true;
              break;
            }

            record({
              name: "check-run-logs",
              status: durationMs > 2600 ? "warn" : "pass",
              durationMs,
              detail: durationMs > 2600 ? `slow response (${formatMs(durationMs)})` : "ok",
            });

            assertCondition(
              "check-run-logs-shape",
              logsText.length > 0,
              "check-run logs route returned content",
            );
            logsChecked = true;
            break;
          }

          if (!logsChecked && logsUnavailable > 0) {
            record({
              name: "check-run-logs",
              status: "skip",
              durationMs: 0,
              detail: "actions logs expired or unavailable for sampled jobs",
            });
          }
        } else {
          record({
            name: "check-run-logs",
            status: "skip",
            durationMs: 0,
            detail: "no actions job id exposed by sampled check runs",
          });
        }
      }
    }

    if (Array.isArray(files) && files[0]?.filename) {
      assertCondition(
        "pull-file-content",
        typeof files[0].filename === "string",
        `first file ${files[0].filename}`,
      );
    }

    if (compareBase && compareHead) {
      await Promise.all([
        timedTextCheck(
          "compare-diff",
          `${BASE_URL}/api/compare/${encodeURIComponent(compareBase)}/${encodeURIComponent(compareHead)}/diff?owner=${owner}&repo=${repo}`,
          {},
          [200],
          2600,
        ),
        timedJsonCheck(
          "compare-files",
          `${BASE_URL}/api/compare/${encodeURIComponent(compareBase)}/${encodeURIComponent(compareHead)}/files?owner=${owner}&repo=${repo}`,
          {},
          [200],
          2600,
        ),
      ]);
    } else {
      record({
        name: "compare-routes",
        status: "skip",
        durationMs: 0,
        detail: "pull base/head refs unavailable",
      });
    }

    await Promise.all([
      sampleRoute(
        "perf-pulls",
        `${BASE_URL}/api/pulls?state=open&page=1&per_page=10`,
        {},
        [200],
        2000,
      ),
      sampleRoute(
        "perf-pull-files",
        `${pullBase}/files?owner=${owner}&repo=${repo}`,
        {},
        [200],
        2200,
      ),
      sampleRoute(
        "perf-pull-checks",
        `${pullBase}/checks?owner=${owner}&repo=${repo}`,
        {},
        [200],
        2400,
      ),
    ]);

    await checkWritePath(owner, repo, firstPull.number);
  }

  await checkSupabasePreferences();

  const failing = results.filter((result) => result.status === "fail");
  const slow = results.filter((result) => result.status === "warn");
  const passing = results.filter((result) => result.status === "pass");
  const skipped = results.filter((result) => result.status === "skip");

  console.log(`\nDIFF app check against ${BASE_URL}\n`);
  for (const result of results) {
    const status = result.status.toUpperCase().padEnd(4, " ");
    const timing = result.durationMs ? formatMs(result.durationMs).padStart(6, " ") : "   -  ";
    console.log(`${status} ${timing}  ${result.name}  ${result.detail}`);
  }

  console.log(
    `\nSummary: ${passing.length} pass, ${slow.length} warn, ${skipped.length} skip, ${failing.length} fail`,
  );

  if (!repoInfo) {
    console.log("Repo route failed. Check the server token and default repo configuration.");
  }

  process.exit(failing.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal check: ", error);
  process.exit(1);
});
