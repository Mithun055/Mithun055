// .github/stats-generator/generate-stats.js
// Produces an SVG with two sections:
// 1) Top card: Total Contributions | Current Streak (ring) | Longest Streak
// 2) Language usage card: horizontal stacked bar + legend
//
// Uses all-time totals (sums year-by-year), computes streaks from day-level calendar,
// and aggregates languages from owned repos.
//
// Requires GH token in env GH_TOKEN (set your repo secret STATS_TOKEN -> GH_TOKEN in the workflow).
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const token = process.env.GH_TOKEN;
const login = process.env.GITHUB_LOGIN || "Mithun055";
if (!token) {
  console.error("GH_TOKEN missing; set STATS_TOKEN secret and map to GH_TOKEN in your workflow.");
  process.exit(1);
}

const REST_HEADERS = { Authorization: `bearer ${token}`, "User-Agent": "stats-generator" };
const GQL_HEADERS = { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "stats-generator" };

function esc(s = "") { return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function nf(n) { return Number(n).toLocaleString("en-US"); }

// GraphQL per-year query for day-level calendar + totals
const gqlYearQuery = `
query($login:String!,$from:DateTime!,$to:DateTime!) {
  user(login:$login) {
    contributionsCollection(from:$from,to:$to) {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
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

async function gqlRequest(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    return { error: json.errors || json };
  }
  return { data: json.data };
}

// fetch owned repos (paginated) up to a given limit
async function fetchOwnedRepos(limit = 200) {
  const per = 100;
  let page = 1;
  const out = [];
  while (out.length < limit) {
    const url = `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=${per}&page=${page}&type=owner`;
    const res = await fetch(url, { headers: REST_HEADERS });
    if (!res.ok) break;
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    out.push(...arr);
    if (arr.length < per) break;
    page++;
    if (page > 10) break;
  }
  return out.slice(0, limit);
}

// aggregate language bytes across repos
async function computeLanguageTotals(repos) {
  const totals = {};
  for (const r of repos) {
    if (!r.languages_url) continue;
    try {
      const res = await fetch(r.languages_url, { headers: REST_HEADERS });
      if (!res.ok) continue;
      const obj = await res.json();
      for (const [lang, bytes] of Object.entries(obj)) {
        totals[lang] = (totals[lang] || 0) + (bytes || 0);
      }
    } catch (e) {
      // ignore per-repo errors
    }
  }
  return totals;
}

// compute streaks from dayMap (date->count)
function computeStreaksFromDayMap(dayMap) {
  const dates = Object.keys(dayMap).sort(); // ascending
  if (dates.length === 0) return { total: 0, currentStreak: 0, longestStreak: 0 };

  const have = new Set(dates.filter(d => (dayMap[d] || 0) > 0));
  const minDate = new Date(dates[0]);
  const maxDate = new Date(dates[dates.length - 1]);

  // longest streak
  let longest = 0;
  let cur = 0;
  let d = new Date(minDate);
  while (d <= maxDate) {
    const key = d.toISOString().slice(0,10);
    if (have.has(key)) {
      cur++;
    } else {
      if (cur > longest) longest = cur;
      cur = 0;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (cur > longest) longest = cur;

  // current streak: walk backward from maxDate
  let current = 0;
  let cd = new Date(maxDate);
  while (true) {
    const key = cd.toISOString().slice(0,10);
    if (have.has(key)) {
      current++;
      cd.setUTCDate(cd.getUTCDate() - 1);
    } else break;
  }

  const totalContribs = Object.values(dayMap).reduce((a,b)=>a+(b||0),0);
  return { total: totalContribs, currentStreak: current, longestStreak: longest };
}

// helper: fetch first contribution date (earliest key)
function getFirstContributionDate(dayMap) {
  const keys = Object.keys(dayMap || {});
  if (keys.length === 0) return null;
  keys.sort();
  const d = new Date(keys[0]);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// simple language color palette fallback
function colorForLang(name) {
  const map = {
    "JavaScript":"#f1e05a","TypeScript":"#2b7489","HTML":"#e34c26","CSS":"#563d7c","Python":"#3572A5",
    "Dart":"#00B4AB","Java":"#b07219","C++":"#f34b7d","SCSS":"#c6538c","Go":"#00ADD8","Shell":"#89e051"
  };
  return map[name] || "#7a5cff";
}

(async () => {
  try {
    // gather per-year calendar days and totals
    const startYear = 2008;
    const currentYear = new Date().getFullYear();
    const dayMap = {};
    let totalCommits = 0, totalPRs = 0, totalReviews = 0, totalIssues = 0, totalPrivate = 0, totalContribs = 0;

    for (let y = startYear; y <= currentYear; y++) {
      const from = `${y}-01-01T00:00:00Z`;
      const to = `${y}-12-31T23:59:59Z`;
      const r = await gqlRequest(gqlYearQuery, { login, from, to });
      if (r.error) {
        // skip the year if GitHub returns validation (e.g., empty) or other errors
        continue;
      }
      const col = r.data.user.contributionsCollection;
      totalCommits += col.totalCommitContributions || 0;
      totalPRs += col.totalPullRequestContributions || 0;
      totalReviews += col.totalPullRequestReviewContributions || 0;
      totalIssues += col.totalIssueContributions || 0;
      totalPrivate += col.restrictedContributionsCount || 0;
      totalContribs += col.contributionCalendar?.totalContributions || 0;

      const weeks = col.contributionCalendar?.weeks || [];
      for (const w of weeks) {
        for (const d of w.contributionDays || []) {
          dayMap[d.date] = (dayMap[d.date] || 0) + (d.contributionCount || 0);
        }
      }
    }

    // compute streaks
    const { total, currentStreak, longestStreak } = computeStreaksFromDayMap(dayMap);

    // languages
    const repos = await fetchOwnedRepos(200);
    const langTotals = await computeLanguageTotals(repos);
    const langEntries = Object.entries(langTotals).sort((a,b)=>b[1]-a[1]);
    const langSum = langEntries.reduce((s,[_l,b])=>s+b,0);
    const topLangs = langEntries.slice(0,6).map(([lang,bytes]) => ({ lang, bytes, pct: langSum ? (bytes/langSum)*100 : 0 }));

    // contributed-to (approx) by counting repos with >0 commits on default branch (limited)
    let contributedToCount = 0;
    try {
      const limited = repos.slice(0, 200);
      const repoQuery = `
      query($owner:String!, $name:String!) {
        repository(owner:$owner, name:$name) {
          defaultBranchRef {
            target {
              ... on Commit { history { totalCount } }
            }
          }
        }
      }`;
      for (const r of limited) {
        try {
          const [owner, name] = r.full_name.split("/");
          const rr = await gqlRequest(repoQuery, { owner, name });
          if (rr.error) continue;
          const t = rr.data.repository?.defaultBranchRef?.target?.history?.totalCount || 0;
          if (t > 0) contributedToCount++;
        } catch (e) { /* ignore per-repo errors */ }
      }
    } catch (e) {
      // ignore
    }

    // profile name
    const profileRes = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: REST_HEADERS });
    const profile = await profileRes.json();
    const displayName = profile?.name || login;

    // Build SVG: two stacked cards (top stats card + languages card)
    const width = 980;
    const topCardH = 160;
    const langCardH = 140;
    const padding = 20;
    const totalHeight = padding + topCardH + 24 + langCardH + padding;

    // layout numbers and ring math
    const leftColX = padding + 20;
    const leftColWidth = 420;
    const rightCenterX = leftColX + leftColWidth + 140;
    const ringRadius = 48;
    const ringStroke = 12;
    const ringCirc = 2 * Math.PI * ringRadius;
    // ring percent: current streak relative to max(current,longest) -> show current proportion
    const ringMax = Math.max(currentStreak, longestStreak, 1);
    const ringPercent = Math.round((currentStreak / ringMax) * 100);
    const ringDash = (ringCirc * ringPercent) / 100;

    // languages bar geometry
    const langBarX = padding + 28;
    const langBarY = padding + topCardH + 48;
    const langBarW = width - langBarX - 28;
    const langBarH = 18;

    // compose language rects
    let langRects = "";
    let accX = 0;
    for (const t of topLangs) {
      const w = Math.max(1, Math.round((t.pct / 100) * langBarW));
      const color = colorForLang(t.lang);
      langRects += `<rect x="${langBarX + accX}" y="${langBarY}" width="${w}" height="${langBarH}" rx="6" fill="${color}"/>`;
      accX += w;
    }

    // language labels
    let labelItems = "";
    let labelX = langBarX;
    const labelGap = 140;
    for (let i = 0; i < topLangs.length; i++) {
      const t = topLangs[i];
      const color = colorForLang(t.lang);
      labelItems += `<g transform="translate(${labelX + (i*labelGap)}, ${langBarY + 28})"><rect x="0" y="-8" width="10" height="10" rx="5" fill="${color}"></rect><text x="14" y="0" font-family="Segoe UI, Roboto" font-size="12" fill="#9aa6b2">${esc(t.lang)} ${t.pct.toFixed(1)}%</text></g>`;
    }

    // first contribution date
    const firstDate = getFirstContributionDate(dayMap) || "—";

    // top card SVG content
    const topCard = `
<g>
  <rect x="${padding}" y="${padding}" width="${width - padding*2}" height="${topCardH}" rx="10" fill="#0f1113" stroke="#232428" stroke-width="1.5"/>
  <text x="${leftColX}" y="${padding + 28}" font-family="Segoe UI, Roboto" font-weight="700" font-size="20" fill="#ff9a3c">🔥 My Stats :</text>

  <!-- left: total contributions -->
  <g transform="translate(${leftColX}, ${padding + 44})" font-family="Segoe UI, Roboto">
    <text x="0" y="0" font-size="34" font-weight="800" fill="#ffffff">${nf(total)}</text>
    <text x="0" y="28" font-size="13" fill="#9aa6b2">Total Contributions</text>
    <text x="0" y="48" font-size="12" fill="#9aa6b2">${esc(firstDate)} - Present</text>
  </g>

  <!-- center: current streak ring -->
  <g transform="translate(${rightCenterX - ringRadius}, ${padding + 28})">
    <!-- background ring -->
    <circle cx="${ringRadius}" cy="${ringRadius}" r="${ringRadius}" stroke="#2e1d20" stroke-width="${ringStroke}" fill="none"/>
    <!-- base ring -->
    <circle cx="${ringRadius}" cy="${ringRadius}" r="${ringRadius}" stroke="#3a2832" stroke-width="${ringStroke}" fill="none"/>
    <!-- progress -->
    <g transform="rotate(-90 ${ringRadius} ${ringRadius})">
      <circle cx="${ringRadius}" cy="${ringRadius}" r="${ringRadius}" stroke="#ff9a3c" stroke-width="${ringStroke}" fill="none" stroke-linecap="round"
        stroke-dasharray="${ringDash} ${ringCirc - ringDash}"/>
    </g>
    <text x="${ringRadius}" y="${ringRadius}" text-anchor="middle" dominant-baseline="central" font-size="28" font-weight="800" fill="#fff">${currentStreak}</text>
    <text x="${ringRadius}" y="${ringRadius + 36}" text-anchor="middle" font-size="12" fill="#9aa6b2">Current Streak</text>
  </g>

  <!-- right: longest streak -->
  <g transform="translate(${rightCenterX + ringRadius + 40}, ${padding + 56})" font-family="Segoe UI, Roboto">
    <text x="0" y="0" font-size="34" font-weight="800" fill="#ffffff">${longestStreak}</text>
    <text x="0" y="30" font-size="13" fill="#9aa6b2">Longest Streak</text>
  </g>
</g>
`;

    // languages card SVG content
    const langCardY = padding + topCardH + 16;
    const langCard = `
<g>
  <rect x="${padding}" y="${langCardY}" width="${width - padding*2}" height="${langCardH}" rx="10" fill="#0f1113" stroke="#232428" stroke-width="1.5"/>
  <text x="${padding + 18}" y="${langCardY + 28}" font-family="Segoe UI, Roboto" font-weight="700" font-size="18" fill="#ff9a3c">Most Used Languages</text>

  <!-- language bar -->
  ${langRects}

  <!-- labels -->
  ${labelItems}
</g>
`;

    // full SVG
    const svg = `<?xml version="1.0" encoding="utf-8"?>
<svg width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(displayName)} stats">
  <rect width="100%" height="100%" fill="#0b1220" />
  ${topCard}
  ${langCard}
</svg>`;

    // write stable and cache-busted files
    const outDir = path.join(process.cwd(), "..", "..", "assets");
    fs.mkdirSync(outDir, { recursive: true });
    const stablePath = path.join(outDir, "stats.svg");
    fs.writeFileSync(stablePath, svg, "utf8");
    const cb = path.join(outDir, `stats-${Date.now()}.svg`);
    fs.writeFileSync(cb, svg, "utf8");

    console.log("Wrote SVGs:", stablePath, cb);
    // success
    process.exit(0);
  } catch (err) {
    console.error("ERROR in generator:", err);
    process.exit(1);
  }
})();
