import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const token = process.env.GH_TOKEN;
const login = process.env.GITHUB_LOGIN || "Mithun055";

if (!token) {
  console.error("GH_TOKEN not provided.");
  process.exit(1);
}

// GraphQL query (1 year max)
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
      "Content-Type": "application/json",
      "User-Agent": "stats-generator"
    },
    body: JSON.stringify({
      query,
      variables: { login, from, to }
    })
  });

  const json = await res.json();
  if (json.errors) {
    console.log(`GraphQL error for year ${year}:`, json.errors);
    return null;
  }

  const col = json.data.user.contributionsCollection;
  return {
    total: col.contributionCalendar.totalContributions || 0,
    commits: col.totalCommitContributions || 0,
    prs: col.totalPullRequestContributions || 0,
    reviews: col.totalPullRequestReviewContributions || 0,
    issues: col.totalIssueContributions || 0,
    private: col.restrictedContributionsCount || 0
  };
}

async function fetchUserProfile(login) {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {
      Authorization: `bearer ${token}`,
      "User-Agent": "stats-generator"
    }
  });
  if (!res.ok) {
    console.warn("Failed to fetch user profile:", res.status, await res.text());
    return null;
  }
  return await res.json();
}

function escapeXml(s = "") {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

(async () => {
  try {
    const currentYear = new Date().getFullYear();
    const startYear = 2008;

    let total = 0;
    let commits = 0;
    let prs = 0;
    let reviews = 0;
    let issues = 0;
    let priv = 0;

    for (let y = startYear; y <= currentYear; y++) {
      console.log("Fetching year:", y);
      const r = await fetchYear(login, y);
      if (!r) continue;
      total += r.total;
      commits += r.commits;
      prs += r.prs;
      reviews += r.reviews;
      issues += r.issues;
      priv += r.private;
    }

    // fetch avatar + name
    const profile = await fetchUserProfile(login);
    const avatar = profile?.avatar_url || "";
    const name = profile?.name || login;

    // format numbers with commas
    const nf = (n) => n.toLocaleString("en-US");

    const updatedAt = new Date().toUTCString();

    // SVG that resembles github-readme-stats "radical" theme and layout
    const width = 920;
    const height = 170;

    const svg = `<?xml version="1.0" encoding="utf-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(name)}'s GitHub stats">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#ff7ab6"/>
      <stop offset="100%" stop-color="#7a5cff"/>
    </linearGradient>
    <style>
      .bg{fill:#0b1220}
      .card{fill:#0f1724; rx:12px;}
      .title{font:700 20px 'Segoe UI', Roboto, Arial; fill:#ff79c6;}
      .name{font:600 16px 'Segoe UI', Roboto, Arial; fill:#cbd5e1;}
      .meta{font:500 13px 'Segoe UI', Roboto, Arial; fill:#94a3b8;}
      .big{font:700 26px 'Segoe UI', Roboto, Arial; fill:#8be9fd;}
      .small{font:500 12px 'Segoe UI', Roboto, Arial; fill:#cbd5e1;}
      .label{font:600 11px 'Segoe UI', Roboto, Arial; fill:#94a3b8;}
      .chip{font:600 12px 'Segoe UI', Roboto, Arial; fill:#0b1220;}
      .muted{fill:#6b7280;}
      .avatar-mask{rx:8;}
    </style>
  </defs>

  <rect width="100%" height="100%" fill="#071327" />
  <g transform="translate(14,14)">
    <rect width="${width-28}" height="${height-28}" rx="12" fill="#0b1220"/>
    <g transform="translate(18,16)">
      <!-- left: avatar + basic name -->
      <g transform="translate(0,0)">
        <rect width="120" height="120" rx="12" fill="url(#g)" opacity="0.08"></rect>
        ${avatar ? `<image href="${avatar}" x="6" y="6" width="108" height="108" clip-path="url(#a)"/>` : `<rect x="6" y="6" width="108" height="108" fill="#111827" rx="8"></rect>`}
      </g>

      <!-- text to the right of avatar -->
      <g transform="translate(140,8)">
        <text x="0" y="20" class="title">${escapeXml(name)}</text>
        <text x="0" y="44" class="name">@${escapeXml(login)}</text>
        <g transform="translate(0,60)">
          <!-- total contributions big -->
          <text x="0" y="28" class="big">${nf(total)}</text>
          <text x="0" y="48" class="small">Total contributions (all time)</text>
        </g>
      </g>
    </g>

    <!-- bottom stats row -->
    <g transform="translate(18,110)">
      <!-- card-like chips -->
      <g transform="translate(0,0)">
        <rect x="0" y="0" width="${width-56}" height="40" rx="8" fill="#07182a" />
        <g transform="translate(16,8)">
          <text x="0" y="14" class="label">Commits</text>
          <text x="0" y="34" class="chip">${nf(commits)}</text>
        </g>

        <g transform="translate(160,8)">
          <text x="0" y="14" class="label">Pull Requests</text>
          <text x="0" y="34" class="chip">${nf(prs)}</text>
        </g>

        <g transform="translate(320,8)">
          <text x="0" y="14" class="label">PR Reviews</text>
          <text x="0" y="34" class="chip">${nf(reviews)}</text>
        </g>

        <g transform="translate(480,8)">
          <text x="0" y="14" class="label">Issues</text>
          <text x="0" y="34" class="chip">${nf(issues)}</text>
        </g>

        <g transform="translate(640,8)">
          <text x="0" y="14" class="label">Private contribs</text>
          <text x="0" y="34" class="chip">${nf(priv)}</text>
        </g>

        <g transform="translate(${width-56 - 140},8)">
          <rect x="-8" y="-6" width="140" height="32" rx="6" fill="url(#g)"/>
          <text x="0" y="14" class="chip" style="fill:#fff">${escapeXml(new Date().toLocaleDateString())}</text>
        </g>
      </g>
    </g>
  </g>
</svg>`;

    const outDir = path.join(process.cwd(), "..", "..", "assets");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "stats.svg");
    fs.writeFileSync(outPath, svg, "utf8");

    console.log("Wrote SVG →", outPath);
    console.log({ total, commits, prs, reviews, issues, priv });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
