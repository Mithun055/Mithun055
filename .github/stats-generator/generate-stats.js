import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const token = process.env.GH_TOKEN;
const login = process.env.GITHUB_LOGIN || "Mithun055";
if (!token) {
  console.error("GH_TOKEN not provided in env (set STATS_TOKEN as secret).");
  process.exit(1);
}

const query = `
query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
      }
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      restrictedContributionsCount
    }
  }
}
`;

const from = "2008-01-01T00:00:00Z";
const to = new Date().toISOString();

async function fetchGraphQL(variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error("GraphQL error:", JSON.stringify(json.errors || json, null, 2));
    throw new Error("GraphQL query failed");
  }
  return json.data;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

(async () => {
  try {
    const data = await fetchGraphQL({ login, from, to });
    const col = data.user.contributionsCollection;

    const total = col.contributionCalendar.totalContributions;
    const commits = col.totalCommitContributions;
    const prs = col.totalPullRequestContributions;
    const reviews = col.totalPullRequestReviewContributions;
    const issues = col.totalIssueContributions;
    const restricted = col.restrictedContributionsCount;
    const updatedAt = new Date().toLocaleString("en-GB");

    const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="920" height="200">
  <style>
    .title{font:700 22px 'Segoe UI'; fill:#ff6bcb;}
    .big{font:700 28px 'Segoe UI'; fill:#8be9fd;}
    .meta{font:500 14px 'Segoe UI'; fill:#cbd5e1;}
    .small{font:400 12px 'Segoe UI'; fill:#94a3b8;}
  </style>
  <rect width="100%" height="100%" fill="#071327"/>
  <text x="24" y="40" class="title">${login}'s GitHub – All-time</text>
  <text x="24" y="80" class="big">${total} total contributions</text>
  <text x="24" y="110" class="meta">Commits: ${commits} • PRs: ${prs} • Reviews: ${reviews} • Issues: ${issues}</text>
  <text x="24" y="135" class="small">Private contributions: ${restricted}</text>
  <text x="24" y="160" class="small">Updated: ${updatedAt}</text>
</svg>`;

    const outDir = path.join(process.cwd(), "..", "..", "assets");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "stats.svg"), svg);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
