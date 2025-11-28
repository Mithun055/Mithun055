import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const token = process.env.GH_TOKEN;
const login = process.env.GITHUB_LOGIN || "Mithun055";

if (!token) {
  console.error("GH_TOKEN not provided.");
  process.exit(1);
}

const query = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
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

async function fetchYear(login, year) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year}-12-31T23:59:59Z`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      variables: { login, from, to }
    })
  });

  const json = await res.json();
  if (json.errors) {
    console.log(`Error for year ${year}:`, json.errors);
    return null;
  }

  const col = json.data.user.contributionsCollection;

  return {
    total: col.contributionCalendar.totalContributions,
    commits: col.totalCommitContributions,
    prs: col.totalPullRequestContributions,
    reviews: col.totalPullRequestReviewContributions,
    issues: col.totalIssueContributions,
    private: col.restrictedContributionsCount
  };
}

(async () => {
  const startYear = 2008;
  const currentYear = new Date().getFullYear();

  let total = 0;
  let commits = 0;
  let prs = 0;
  let reviews = 0;
  let issues = 0;
  let priv = 0;

  for (let year = startYear; year <= currentYear; year++) {
    console.log("Fetching year:", year);
    const d = await fetchYear(login, year);
    if (!d) continue;

    total += d.total;
    commits += d.commits;
    prs += d.prs;
    reviews += d.reviews;
    issues += d.issues;
    priv += d.private;
  }

  const updatedAt = new Date().toLocaleString("en-GB");

  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200">
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
  <text x="24" y="135" class="small">Private contributions: ${priv}</text>
  <text x="24" y="160" class="small">Updated: ${updatedAt}</text>
</svg>`;

  const outDir = path.join(process.cwd(), "..", "..", "assets");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, "stats.svg");
  fs.writeFileSync(outPath, svg);

  console.log("Wrote SVG →", outPath);
})();
