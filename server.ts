import "dotenv/config";
import express from "express";
import path from "path";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { writeFile } from "node:fs/promises";

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  app.use(express.json());

  // GitHub API integration
  const REPO_OWNER = process.env.GITHUB_REPO_OWNER || "coccinella-labs";
  const REPO_NAME = process.env.GITHUB_REPO_NAME || "harper";
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL?.trim();
  const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY?.trim();
  const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

  class HttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }

  const getGitHubToken = (req?: express.Request) => {
    const providerTokenHeader = req?.headers["x-github-provider-token"];
    const providerToken = Array.isArray(providerTokenHeader)
      ? providerTokenHeader[0]
      : providerTokenHeader;

    if (providerToken) {
      return providerToken.trim();
    }

    return process.env.GITHUB_TOKEN || null;
  };

  const getHeaders = (accept: string, req?: express.Request) => {
    const headers: any = { Accept: accept };
    const githubToken = getGitHubToken(req);
    if (githubToken) {
      headers.Authorization = `token ${githubToken}`;
    }
    return headers;
  };

  const getRepoCtx = (req: any) => ({
    owner: (req.query.owner as string) || REPO_OWNER,
    repo: (req.query.repo as string) || REPO_NAME,
  });

  if (!process.env.VERCEL) {
    app.post("/api/dev/e2e-session", async (req, res) => {
      const snapshot = req.body;
      if (
        !snapshot ||
        typeof snapshot !== "object" ||
        typeof snapshot.access_token !== "string" ||
        typeof snapshot.refresh_token !== "string"
      ) {
        res.status(400).json({ error: "Valid Supabase session snapshot required." });
        return;
      }

      if (!supabase) {
        res.status(503).json({ error: "Supabase auth is not configured on the server." });
        return;
      }

      const { data: authData, error: authError } = await supabase.auth.getUser(
        snapshot.access_token,
      );
      if (authError || !authData.user) {
        res.status(401).json({
          error: authError?.message || "Invalid Supabase session snapshot.",
        });
        return;
      }

      await writeFile(
        "/tmp/diff-session.json",
        `${JSON.stringify(snapshot)}\n`,
        "utf8",
      );
      res.json({ ok: true, path: "/tmp/diff-session.json" });
    });
  }

  const readBearerToken = (req: express.Request) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }

    return authHeader.slice("Bearer ".length).trim();
  };

  const getAuthenticatedGitHubContext = async (req: express.Request) => {
    if (!supabase) {
      throw new HttpError(
        503,
        "Supabase auth is not configured on the server.",
      );
    }

    const accessToken = readBearerToken(req);
    const providerTokenHeader = req.headers["x-github-provider-token"];
    const githubProviderToken = Array.isArray(providerTokenHeader)
      ? providerTokenHeader[0]
      : providerTokenHeader;

    if (!accessToken) {
      throw new HttpError(401, "Supabase session token required.");
    }

    if (!githubProviderToken) {
      throw new HttpError(401, "GitHub provider token required.");
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(
      accessToken,
    );

    if (authError || !authData.user) {
      throw new HttpError(401, authError?.message || "Invalid Supabase session.");
    }

    const githubUserResponse = await axios.get("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${githubProviderToken}`,
      },
    });

    const githubUser = githubUserResponse.data;
    const userMetadata = authData.user.user_metadata || {};
    const allowedLogins = [
      userMetadata.user_name,
      userMetadata.preferred_username,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.toLowerCase());
    const providerId =
      typeof userMetadata.provider_id === "string"
        ? userMetadata.provider_id
        : null;

    if (
      allowedLogins.length > 0 &&
      !allowedLogins.includes(String(githubUser.login || "").toLowerCase())
    ) {
      throw new HttpError(
        403,
        "GitHub token does not match the signed-in Supabase user.",
      );
    }

    if (providerId && String(githubUser.id) !== providerId) {
      throw new HttpError(
        403,
        "GitHub identity does not match the signed-in Supabase user.",
      );
    }

    return {
      authUser: authData.user,
      githubProviderToken,
      githubLogin: githubUser.login,
    };
  };

  const handleError = (res: any, error: any, context: string) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const errorMsg =
      error.response?.data?.message || error.message || "Unknown error";
    const displayMsg =
      typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg);
    console.error(`GitHub API Error (${context}):`, displayMsg);
    res.status(error.response?.status || 500).json({ error: displayMsg });
  };

  const hasNoCommonAncestor = (error: any) => {
    const message = error.response?.data?.message || error.message || "";
    return typeof message === "string" && message.includes("No common ancestor");
  };

  const getActionsJobIdFromCheckRun = (checkRun: any) => {
    const candidateUrls = [
      checkRun?.details_url,
      checkRun?.html_url,
    ].filter((value): value is string => typeof value === "string");

    for (const url of candidateUrls) {
      const match = url.match(/\/job\/(\d+)(?:\D|$)/);
      if (match) {
        return match[1];
      }
    }

    if (checkRun?.app?.slug === "github-actions" && typeof checkRun?.id === "number") {
      return String(checkRun.id);
    }

    return null;
  };

  app.get("/api/pulls", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const state = req.query.state || "open";
      const page = req.query.page || 1;
      const perPage = req.query.per_page || 30;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}&page=${page}`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      if (error.response?.status === 404) {
        try {
          const { owner, repo } = getRepoCtx(req);
          await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: getHeaders("application/vnd.github.v3+json"),
          });
          res.json([]);
          return;
        } catch {
          // fall through to the original 404 handling below if the repo itself is invalid
        }
      }
      handleError(res, error, "Pulls");
    }
  });

  app.get("/api/pulls/:number", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "Pull");
    }
  });

  app.get("/api/pulls/:number/diff", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
        { headers: getHeaders("application/vnd.github.v3.diff") },
      );
      res.send(response.data);
    } catch (error: any) {
      handleError(res, error, "Diff");
    }
  });

  app.get("/api/pulls/:number/files", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "Files");
    }
  });

  app.get("/api/pulls/:number/comments", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
        { headers: getHeaders("application/vnd.github.v3+json", req) },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "Comments");
    }
  });

  app.post("/api/pulls/:number/comments", async (req, res) => {
    try {
      const { githubProviderToken } = await getAuthenticatedGitHubContext(req);

      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const body =
        typeof req.body?.body === "string" ? req.body.body.trim() : "";

      if (!body) {
        res.status(400).json({ error: "Comment body is required." });
        return;
      }

      const response = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
        { body },
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `token ${githubProviderToken}`,
          },
        },
      );

      res.status(201).json(response.data);
    } catch (error: any) {
      handleError(res, error, "CreateComment");
    }
  });

  app.post("/api/pulls/:number/review-comments", async (req, res) => {
    try {
      const { githubProviderToken } = await getAuthenticatedGitHubContext(req);
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const body =
        typeof req.body?.body === "string" ? req.body.body.trim() : "";
      const path = typeof req.body?.path === "string" ? req.body.path.trim() : "";
      const commitId =
        typeof req.body?.commit_id === "string" ? req.body.commit_id.trim() : "";
      const line = Number(req.body?.line);
      const side =
        req.body?.side === "LEFT" || req.body?.side === "RIGHT"
          ? req.body.side
          : "RIGHT";
      const startLine =
        req.body?.start_line == null ? null : Number(req.body.start_line);
      const startSide =
        req.body?.start_side === "LEFT" || req.body?.start_side === "RIGHT"
          ? req.body.start_side
          : side;

      if (!body) {
        res.status(400).json({ error: "Review comment body is required." });
        return;
      }

      if (!path || !commitId || !Number.isFinite(line) || line <= 0) {
        res.status(400).json({
          error: "path, commit_id, and a valid line number are required.",
        });
        return;
      }

      const payload: Record<string, unknown> = {
        body,
        path,
        commit_id: commitId,
        line,
        side,
      };

      if (
        startLine != null &&
        Number.isFinite(startLine) &&
        startLine > 0 &&
        startLine !== line
      ) {
        payload.start_line = startLine;
        payload.start_side = startSide;
      }

      const response = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/comments`,
        payload,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `token ${githubProviderToken}`,
          },
        },
      );

      res.status(201).json(response.data);
    } catch (error: any) {
      handleError(res, error, "CreateReviewComment");
    }
  });

  app.post("/api/pulls/:number/reviews", async (req, res) => {
    try {
      const { githubProviderToken } = await getAuthenticatedGitHubContext(req);
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const body =
        typeof req.body?.body === "string" ? req.body.body.trim() : undefined;
      const event =
        req.body?.event === "COMMENT" ||
        req.body?.event === "APPROVE" ||
        req.body?.event === "REQUEST_CHANGES"
          ? req.body.event
          : "COMMENT";

      if (event === "REQUEST_CHANGES" && !body) {
        res.status(400).json({
          error: "A review body is required when requesting changes.",
        });
        return;
      }

      const response = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews`,
        {
          body,
          event,
        },
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `token ${githubProviderToken}`,
          },
        },
      );

      res.status(201).json(response.data);
    } catch (error: any) {
      handleError(res, error, "CreateReview");
    }
  });

  app.get("/api/pulls/:number/review-comments", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/comments`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "ReviewComments");
    }
  });

  app.get("/api/pulls/:number/reviews", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "Reviews");
    }
  });

  app.get("/api/pulls/:number/timeline", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`,
        { headers: getHeaders("application/vnd.github+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "Timeline");
    }
  });

  app.get("/api/pulls/:number/edits", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.post(
        "https://api.github.com/graphql",
        {
          query: `
            query PullRequestEdits($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) {
                  userContentEdits(first: 100) {
                    nodes {
                      editedAt
                      deletedAt
                      diff
                      editor {
                        login
                        avatarUrl
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: {
            owner,
            repo,
            number: Number(number),
          },
        },
        { headers: getHeaders("application/vnd.github+json") },
      );

      res.json(
        response.data.data?.repository?.pullRequest?.userContentEdits?.nodes || [],
      );
    } catch (error: any) {
      handleError(res, error, "Edits");
    }
  });

  app.get("/api/pulls/:number/commits", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/commits`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "Commits");
    }
  });

  app.get("/api/pulls/:number/checks", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { number } = req.params;

      const prResponse = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );

      const headSha = prResponse.data.head.sha;
      const mergeSha = prResponse.data.merge_commit_sha;
      const mergeable = prResponse.data.mergeable;
      const mergeStateStatus = prResponse.data.mergeable_state;

      // Fetch checks for a specific SHA
      const fetchForSha = async (sha: string) => {
        const [checks, statuses] = await Promise.all([
          axios.get(
            `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
            { headers: getHeaders("application/vnd.github.v3+json") },
          ),
          axios.get(
            `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/statuses?per_page=100`,
            { headers: getHeaders("application/vnd.github.v3+json") },
          )
        ]);
        return { checks: checks.data.check_runs || [], statuses: statuses.data || [] };
      };

      // Fetch both (merging them gives a more complete picture of PR status)
      const [headData, mergeData] = await Promise.all([
        fetchForSha(headSha),
        (async () => {
          if (mergeSha && mergeSha !== headSha) {
            try {
              return await fetchForSha(mergeSha);
            } catch (e) {
              return { checks: [], statuses: [] };
            }
          }
          return { checks: [], statuses: [] };
        })()
      ]);

      // Keep distinct runs, but collapse duplicate skipped reruns for the same name.
      const groupedChecks = new Map<string, any[]>();
      const uniqueStatuses = new Map();

      [...mergeData.checks, ...headData.checks].forEach((c: any) => {
        const existing = groupedChecks.get(c.name) || [];
        existing.push({ ...c, type: "check_run" });
        groupedChecks.set(c.name, existing);
      });

      const normalizedChecks = Array.from(groupedChecks.values()).flatMap((runs) => {
        if (runs.every((run) => run.conclusion === "skipped")) {
          const latestSkipped = runs
            .slice()
            .sort((a, b) => {
              const aTime = new Date(a.completed_at || a.started_at || 0).getTime();
              const bTime = new Date(b.completed_at || b.started_at || 0).getTime();
              return bTime - aTime;
            })[0];
          return latestSkipped ? [latestSkipped] : [];
        }

        return runs;
      });

      [...mergeData.statuses, ...headData.statuses].forEach((s: any) => {
        if (!uniqueStatuses.has(s.context)) {
          uniqueStatuses.set(s.context, {
            id: s.id,
            name: s.context || "Commit Status",
            status: s.state === "pending" ? "in_progress" : "completed",
            conclusion: s.state === "success" ? "success" :
                       (s.state === "failure" || s.state === "error") ? "failure" :
                       s.state === "pending" ? null : "other",
            html_url: s.target_url,
            description: s.description,
            avatar_url: s.avatar_url,
            type: "status"
          });
        }
      });

      const allChecks = [
        ...normalizedChecks,
        ...Array.from(uniqueStatuses.values())
      ];

      res.json({
        check_runs: allChecks,
        mergeable,
        merge_state_status: mergeStateStatus,
      });
    } catch (error: any) {
      handleError(res, error, "Checks");
    }
  });

  app.get("/api/branches", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const page = req.query.page || 1;
      const perPage = req.query.per_page || 30;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/branches?per_page=${perPage}&page=${page}`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "Branches");
    }
  });

  app.get("/api/compare/:base/:head/diff", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { base, head } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`,
        { headers: getHeaders("application/vnd.github.v3.diff") },
      );
      res.send(response.data);
    } catch (error: any) {
      if (hasNoCommonAncestor(error)) {
        res.send("");
        return;
      }
      handleError(res, error, "CompareDiff");
    }
  });

  app.get("/api/compare/:base/:head/files", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { base, head } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data.files);
    } catch (error: any) {
      if (hasNoCommonAncestor(error)) {
        res.json([]);
        return;
      }
      handleError(res, error, "CompareFiles");
    }
  });

  app.get("/api/compare/:base/:head/commits", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { base, head } = req.params;
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data.commits || []);
    } catch (error: any) {
      if (hasNoCommonAncestor(error)) {
        res.json([]);
        return;
      }
      handleError(res, error, "CompareCommits");
    }
  });

  app.get("/api/repo", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      res.json(response.data);
    } catch (error: any) {
      handleError(res, error, "Repo");
    }
  });

  app.get("/api/checks/:check_run_id", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { check_run_id } = req.params;

      const runDetail = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/check-runs/${check_run_id}`,
        { headers: getHeaders("application/vnd.github.v3+json") },
      );
      const actionsJobId = getActionsJobIdFromCheckRun(runDetail.data);

      const [annotations, suiteRuns, actionsJob] = await Promise.all([
        axios.get(
          `https://api.github.com/repos/${owner}/${repo}/check-runs/${check_run_id}/annotations`,
          { headers: getHeaders("application/vnd.github.v3+json") },
        ).catch(() => ({ data: [] })),
        runDetail.data.check_suite?.id
          ? axios.get(
              `https://api.github.com/repos/${owner}/${repo}/check-suites/${runDetail.data.check_suite.id}/check-runs`,
              { headers: getHeaders("application/vnd.github.v3+json") }
            ).catch(() => ({ data: { check_runs: [] } }))
          : Promise.resolve({ data: { check_runs: [] } }),
        actionsJobId
          ? axios.get(
              `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${actionsJobId}`,
              { headers: getHeaders("application/vnd.github+json") },
            ).catch(() => ({ data: null }))
          : Promise.resolve({ data: null }),
      ]);

      const actionJobData = actionsJob.data;
      const mergedSteps = Array.isArray(actionJobData?.steps) && actionJobData.steps.length > 0
        ? actionJobData.steps
        : runDetail.data.steps || [];

      res.json({
        ...runDetail.data,
        steps: mergedSteps,
        ...(actionJobData
          ? {
              runner_name: actionJobData.runner_name,
              job_id: actionJobData.id,
              labels: actionJobData.labels,
              started_at: actionJobData.started_at || runDetail.data.started_at,
              completed_at: actionJobData.completed_at || runDetail.data.completed_at,
            }
          : actionsJobId
          ? {
              job_id: Number(actionsJobId),
            }
          : {}),
        annotations: annotations.data || [],
        suite_runs: suiteRuns.data.check_runs || []
      });
    } catch (error: any) {
      handleError(res, error, "CheckRunDetail");
    }
  });

  app.get("/api/checks/:job_id/logs", async (req, res) => {
    try {
      const { owner, repo } = getRepoCtx(req);
      const { job_id } = req.params;

      // Try to get logs from GitHub Actions Jobs API.
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${job_id}/logs`,
        {
          headers: getHeaders("application/vnd.github+json"),
          responseType: "text",
          maxRedirects: 5,
        },
      );

      if (typeof response.data !== "string") {
        return res.status(404).json({ error: "Logs returned in unexpected format or not available" });
      }

      res.header("Content-Type", "text/plain");
      res.send(response.data);
    } catch (error: any) {
      const status = error.response?.status || 500;
      const message = status === 404
        ? "Logs are no longer available (likely expired) or this is not a GitHub Actions run."
        : "Failed to retrieve logs from GitHub.";
      res.status(status).json({ error: message, details: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Only listen if not running as a Vercel function
  if (process.env.VERCEL === undefined) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  return app;
}

export default startServer();
