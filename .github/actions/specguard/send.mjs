import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const MAX_FILES = 60;
const MAX_TOTAL_PATCH_CHARACTERS = 60_000;
const MAX_FILE_PATCH_CHARACTERS = 30_000;
const MAX_BODY_BYTES = 88_000;

function assertEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.webtrigger.atlassian.app')) {
    throw new Error('SPECGUARD_ENDPOINT must be an HTTPS Forge v2 webtrigger URL.');
  }
  return url;
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub pull request API request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function assertCurrentPullRequestHead(pullRequest, expectedHeadSha) {
  const currentHeadSha = pullRequest?.head?.sha;
  if (typeof currentHeadSha !== 'string' || currentHeadSha.length === 0) {
    throw new Error('GitHub returned an unexpected pull request response.');
  }
  if (currentHeadSha !== expectedHeadSha) {
    throw new Error(
      'SpecGuard refused a stale workflow event because the pull request head SHA has changed. Run the latest workflow instead.',
    );
  }
}

async function verifyCurrentPullRequestHead({
  apiUrl,
  repository,
  pullRequestNumber,
  expectedHeadSha,
  token,
}) {
  const requestUrl = `${apiUrl}/repos/${repository}/pulls/${pullRequestNumber}`;
  const pullRequest = await githubJson(requestUrl, token);
  assertCurrentPullRequestHead(pullRequest, expectedHeadSha);
}

async function collectChangedFiles({ apiUrl, repository, pullRequestNumber, token }) {
  const files = [];
  let page = 1;
  let patchCharacters = 0;
  let truncated = false;

  while (files.length < MAX_FILES) {
    const requestUrl = `${apiUrl}/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`;
    const responseFiles = await githubJson(requestUrl, token);
    if (!Array.isArray(responseFiles)) {
      throw new Error('GitHub returned an unexpected pull request files response.');
    }
    for (const file of responseFiles) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      const rawPatch = typeof file.patch === 'string' ? file.patch : undefined;
      const available = Math.max(0, MAX_TOTAL_PATCH_CHARACTERS - patchCharacters);
      const patchLimit = Math.min(MAX_FILE_PATCH_CHARACTERS, available);
      const patch = rawPatch?.slice(0, patchLimit);
      const patchTruncated = !rawPatch || rawPatch.length > patchLimit;
      if (patchTruncated) truncated = true;
      patchCharacters += patch?.length ?? 0;
      files.push({
        path: String(file.filename),
        status: String(file.status),
        additions: Number(file.additions ?? 0),
        deletions: Number(file.deletions ?? 0),
        ...(patch ? { patch } : {}),
        patchTruncated,
        ...(file.previous_filename ? { previousPath: String(file.previous_filename) } : {}),
      });
    }
    if (responseFiles.length < 100) break;
    page += 1;
    if (page > 30) {
      truncated = true;
      break;
    }
  }

  return { files, truncated };
}

function fitBody(payload) {
  let body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES) return body;

  payload.diffTruncated = true;
  for (let index = payload.files.length - 1; index >= 0; index -= 1) {
    if (payload.files[index].patch) {
      delete payload.files[index].patch;
      payload.files[index].patchTruncated = true;
      body = JSON.stringify(payload);
      if (Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES) return body;
    }
  }
  throw new Error('The bounded SpecGuard request still exceeds its safe payload limit.');
}

async function run() {
  const endpoint = assertEndpoint(process.env.SPECGUARD_ENDPOINT ?? '');
  const secret = process.env.SPECGUARD_SECRET;
  const token = process.env.SPECGUARD_GITHUB_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!secret || !token || !eventPath) {
    throw new Error('SpecGuard endpoint, secret, GitHub token, and event payload are required.');
  }

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  if (!event.pull_request || !event.repository?.full_name) {
    throw new Error('SpecGuard only supports the GitHub pull_request event.');
  }
  if (event.pull_request.head?.repo?.full_name !== event.repository.full_name) {
    console.log(
      'SpecGuard skipped a fork pull request because repository secrets are unavailable.',
    );
    return;
  }

  const repository = String(event.repository.full_name).toLowerCase();
  const pullRequestNumber = Number(event.pull_request.number);
  const headSha = String(event.pull_request.head.sha);
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  await verifyCurrentPullRequestHead({
    apiUrl,
    repository,
    pullRequestNumber,
    expectedHeadSha: headSha,
    token,
  });
  const collected = await collectChangedFiles({
    apiUrl,
    repository,
    pullRequestNumber,
    token,
  });
  const payload = {
    version: '1',
    event: 'pull_request',
    repository,
    pullRequest: {
      number: pullRequestNumber,
      url: String(event.pull_request.html_url),
      title: String(event.pull_request.title ?? '').slice(0, 1024),
      body: String(event.pull_request.body ?? '').slice(0, 4000),
      headSha,
      baseSha: String(event.pull_request.base.sha),
      branch: String(event.pull_request.head.ref).slice(0, 512),
    },
    files: collected.files,
    diffTruncated: collected.truncated,
    collectedAt: new Date().toISOString(),
  };
  const body = fitBody(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(24).toString('base64url');
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`v1:${timestamp}:${nonce}:${bodyHash}`, 'utf8')
    .digest('hex');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-specguard-timestamp': timestamp,
      'x-specguard-nonce': nonce,
      'x-specguard-content-sha256': bodyHash,
      'x-specguard-signature': `v1=${signature}`,
    },
    body,
  });
  if (response.status !== 202) {
    throw new Error(
      `SpecGuard rejected the request with HTTP ${response.status}. Check the mapping, Jira key, endpoint, and secret.`,
    );
  }
  console.log(`SpecGuard accepted PR #${pullRequestNumber} for bounded asynchronous analysis.`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'SpecGuard Action failed.');
  process.exitCode = 1;
});
