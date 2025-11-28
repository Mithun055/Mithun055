// .github/stats-generator/generate-stats.js
// Produces an SVG with the same UI as your previous card, but uses ALL-TIME totals.
// Requires GH token in STATS_TOKEN secret (exposed to workflow as GH_TOKEN).
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const token = process.env.GH_TOKEN;
const login = process.env.GITHUB_LOGIN || "Mithun055";

if (!token) {
  console.error("GH_TOKEN required in environment");
  process.exit(1);
}

const REST_HEADERS = { Authorization: `bearer ${token}`, "User-Agent": "stats-generator" };
const GQL_HEADERS = { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "stats-generator" };

// GraphQL query for a single year window (we will call it year-by-year)
const gqlYearQuery = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { totalContributions }
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      restrictedContributionsCount
    }
  }
}
`;

// helper to call GraphQL
async function gqlRequest(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) {
    // surface errors but don't crash immediately — caller may handle
    return { errors: json.errors };
  }
  return { data: json.data };
}

async function fetchYearTotals(login, year) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year}-12-31T23:59:59Z`;
  const r = await gqlRequest(gqlYearQuery, { login, from, to });
  if (r.errors) return { error: r.errors };
  const col = r.data.user.contributionsCollection;
  return {
    total: col.contributionCalendar?.totalContributions || 0,
    commits: col.totalCommitContributions || 0,
    prs: col.totalPullRequestContributions || 0,
    reviews: col.totalPullRequestReviewContributions || 0,
    issues: col.totalIssueContributions || 0,
    priv: col.restrictedContributionsCount || 0
  };
}

// sum stars across all owned repos (paginated)
async function fetchTotalStars(login) {
  let page = 1;
  const per_page = 100;
  let totalStars = 0;
  while (true) {
    const url = `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=${per_page}&page=${page}&type=owner`;
    const res = await fetch(url, { headers: REST_HEADERS });
    if (!res.ok) {
      console.warn("Failed to fetch repos page", page, res.status);
      break;
    }
    const repos = await res.json();
    if (!Array.isArray(repos) || repos.length === 0) break;
    for (const r of repos) {
      totalStars += (r.stargazers_count || 0);
    }
    if (repos.length < per_page) break;
    page++;
    if (page > 50) break; // safety limit
  }
  return totalStars;
}

// approximate "contributed to (all-time)" by counting repos with >0 commits on default branch
// limited to first N repos for speed; increase if you want exact across many repos
async function fetchContributedToCount(login, limit = 200) {
  // fetch owned repos (first pages until reaching limit)
  let page = 1, per_page = 100, got = [];
  while (got.length < limit) {
    const url = `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=${per_page}&page=${page}&type=owner`;
    const res = await fetch(url, { headers: REST_HEADERS });
    if (!res.ok) break;
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) break;
    got.push(...list);
    if (list.length < per_page) break;
    page++;
    if (page > 10) break;
  }
  const limited = got.slice(0, limit);
  let count = 0;
  // for each repo, query default branch commit totalCount (all-time)
  const repoQuery = `
  query($owner:String!, $name:String!) {
    repository(owner:$owner, name:$name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history { totalCount }
          }
        }
      }
    }
  }`;
  for (const r of limited) {
    try {
      const [owner, name] = r.full_name.split("/");
      const res = await gqlRequest(repoQuery, { owner, name });
      if (res.errors) continue;
      const t = res.data.repository?.defaultBranchRef?.target?.history?.totalCount || 0;
      if (t > 0) count++;
    } catch (e) {
      // ignore per-repo failures
    }
  }
  return count;
}

function esc(s = "") {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function nf(n) { return Number(n).toLocaleString("en-US"); }

(async () => {
  try {
    // sum year-by-year from an early start to current year
    const startYear = 2008;
    const currentYear = new Date().getFullYear();

    let total = 0;
    let commits = 0;
    let prs = 0;
    let reviews = 0;
    let issues = 0;
    let priv = 0;

    for (let y = startYear; y <= currentYear; y++) {
      console.log("fetching year", y);
      const r = await fetchYearTotals(login, y);
      if (r.error) {
        console.warn("skipping year due to error", y, r.error);
        continue;
      }
      total += r.total;
      commits += r.commits;
      prs += r.prs;
      reviews += r.reviews;
      issues += r.issues;
      priv += r.priv;
    }

    // fetch total stars and contributed-to (approx)
    console.log("fetching total stars");
    const totalStars = await fetchTotalStars(login);

    console.log("fetching contributed-to count (approx)");
    const contributedToCount = await fetchContributedToCount(login, 200);

    // fetch profile
    const profileRes = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: REST_HEADERS });
    const profile = await profileRes.json();
    const displayName = profile?.name || login;

    // build SVG (same UI card as before)
    const width = 880;
    const height = 180;
    const leftWidth = 520;
    const rightX = leftWidth + 40;
    const radius = 48;
    const ringStroke = 10;
    const total_last_year = 0; // not used here; keep UI consistent
    // compute percent of goal using overall total contributions (visual)
    const goal = 2000; // arbitrary visual goal for ring; adjust if you prefer
    const percent = Math.min(100, Math.round((total / goal) * 100));
    const cx = rightX + radius;
    const cy = 90;

    // inline simplified icons
    const starPath = "M12 .587l3.668 7.431 8.2 1.192-5.934 5.787 1.402 8.168L12 18.896l-7.336 3.869 1.402-8.168L.132 9.21l8.2-1.192z";
    const clockPath = "M12 2v10l6 3"; // stylized
    const prPath = "M6 2a2 2 0 100 4 2 2 0 000-4z M6 6v6"; // stylized
    const issuePath = "M12 2a10 10 0 110 20 10 10 0 010-20z";
    const repoPath = "M3 3h14v10H3z";

    const svg = `<?xml version="1.0" encoding="utf-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(displayName)}'s GitHub overall stats">
  <style>
    .card{fill:#16151a; stroke:#2b2f3a; stroke-width:1.5; rx:10}
    .title{font:700 18px 'Segoe UI', Roboto, Arial; fill:#ff69b4}
    .label{font:600 13px 'Segoe UI', Roboto, Arial; fill:#bfeefc}
    .val{font:700 18px 'Segoe UI', Roboto, Arial; fill:#9af3ff}
    .small{font:500 11px 'Segoe UI', Roboto, Arial; fill:#cbd5e1}
    .icon{fill:#ffd36b}
    .chip{font:700 13px 'Segoe UI', Roboto, Arial; fill:#c3f4ff}
  </style>

  <rect x="8" y="8" width="${width-16}" height="${height-16}" rx="10" fill="#16151a" stroke="#2b2f3a" stroke-width="1.5"/>
  <g transform="translate(24,20)">
    <text x="0" y="0" class="title">${esc(displayName)}' GitHub Stats</text>

    <g transform="translate(0,22)">
      <g transform="translate(0,0)">
        <svg x="0" y="0" width="18" height="18" viewBox="0 0 24 24"><path class="icon" d="${starPath}"/></svg>
        <text x="30" y="13" class="label">Total Stars Earned:</text>
        <text x="${leftWidth - 80}" y="13" text-anchor="end" class="val">${nf(totalStars)}</text>
      </g>

      <g transform="translate(0,28)">
        <svg x="0" y="0" width="18" height="18" viewBox="0 0 24 24"><path class="icon" d="${clockPath}"/></svg>
        <text x="30" y="13" class="label">Total Commits:</text>
        <text x="${leftWidth - 80}" y="13" text-anchor="end" class="val">${nf(commits)}</text>
      </g>

      <g transform="translate(0,56)">
        <svg x="0" y="0" width="18" height="18" viewBox="0 0 24 24"><path class="icon" d="${prPath}"/></svg>
        <text x="30" y="13" class="label">Total PRs:</text>
        <text x="${leftWidth - 80}" y="13" text-anchor="end" class="val">${nf(prs)}</text>
      </g>

      <g transform="translate(0,84)">
        <svg x="0" y="0" width="18" height="18" viewBox="0 0 24 24"><path class="icon" d="${issuePath}"/></svg>
        <text x="30" y="13" class="label">Total Issues:</text>
        <text x="${leftWidth - 80}" y="13" text-anchor="end" class="val">${nf(issues)}</text>
      </g>

      <g transform="translate(0,112)">
        <svg x="0" y="0" width="18" height="18" viewBox="0 0 24 24"><path class="icon" d="${repoPath}"/></svg>
        <text x="30" y="13" class="label">Contributed to (all time):</text>
        <text x="${leftWidth - 80}" y="13" text-anchor="end" class="val">${nf(contributedToCount)}</text>
      </g>
    </g>

    <!-- right circular ring -->
    <g transform="translate(${rightX},0)">
      <defs>
        <linearGradient id="g1" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#ff7ab6"/>
          <stop offset="100%" stop-color="#7a5cff"/>
        </linearGradient>
      </defs>

      <circle cx="${cx - rightX}" cy="${cy - 20}" r="${radius}" stroke="#2d1b2e" stroke-width="${ringStroke}" fill="none" />
      <g transform="rotate(-90 ${cx - rightX} ${cy - 20})">
        <circle cx="${cx - rightX}" cy="${cy - 20}" r="${radius}" stroke="#45233a" stroke-width="${ringStroke}" fill="none" />
        <circle cx="${cx - rightX}" cy="${cy - 20}" r="${radius}" stroke="url(#g1)" stroke-width="${ringStroke}" fill="none"
          stroke-linecap="round"
          stroke-dasharray="${(2*Math.PI*radius)*(percent/100)} ${(2*Math.PI*radius)}" />
      </g>

      <text x="${cx - rightX}" y="${cy - 20}" text-anchor="middle" dominant-baseline="central" class="chip" font-size="32" fill="#cdeff5">C</text>
      <text x="${cx - rightX}" y="${cy + 42 - 20}" text-anchor="middle" class="small" fill="#9fd8e8">${percent}% of goal</text>
    </g>
  </g>
</svg>`;

    const outDir = path.join(process.cwd(), "..", "..", "assets");
    fs.mkdirSync(outDir, { recursive: true });
    const stablePath = path.join(outDir, "stats.svg");
    fs.writeFileSync(stablePath, svg, "utf8");
    const cbPath = path.join(outDir, `stats-${Date.now()}.svg`);
    fs.writeFileSync(cbPath, svg, "utf8");

    console.log("Wrote stats.svg and cache-busted copy. Totals:", { total, commits, prs, issues, priv, totalStars, contributedToCount });
  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
})();
