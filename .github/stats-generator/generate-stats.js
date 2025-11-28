// generate-stats.js
// All-time totals UI: Total contributions | Current streak (ring) | Longest streak
// + Most used languages bar. Uses GitHub REST + GraphQL. Expects GH token in env GH_TOKEN.
import fs from "fs";
import path from "path";

const token = process.env.GH_TOKEN;
const login = process.env.GITHUB_LOGIN || "Mithun055";
if (!token) {
  console.error("GH_TOKEN not provided (set STATS_TOKEN secret and map to GH_TOKEN in workflow).");
  process.exit(1);
}

// helpers
const headersRest = { Authorization: `bearer ${token}`, "User-Agent": "stats-generator" };
const headersGql = { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "stats-generator" };

function esc(s = "") { return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function nf(n){ return Number(n).toLocaleString("en-US"); }

// GraphQL query to get contributionCalendar weeks (per-year)
const gqlYearQuery = `
query($login:String!,$from:DateTime!,$to:DateTime!) {
  user(login:$login) {
    contributionsCollection(from:$from,to:$to) {
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      restrictedContributionsCount
    }
  }
}
`;

async function gqlCall(variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: headersGql,
    body: JSON.stringify({ query: gqlYearQuery, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    // return errors as object so caller can decide
    return { error: json.errors || json };
  }
  return { data: json.data };
}

// fetch all owners' repos pages (limited)
async function fetchOwnedRepos(limit = 200) {
  const per = 100;
  let page = 1;
  const out = [];
  while (out.length < limit) {
    const url = `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=${per}&page=${page}&type=owner`;
    const res = await fetch(url, { headers: headersRest });
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

// fetch languages for repos and aggregate bytes
async function computeLanguageTotals(repos) {
  const totals = {};
  for (const r of repos) {
    if (!r.languages_url) continue;
    try {
      const res = await fetch(r.languages_url, { headers: headersRest });
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

// compute streaks & totals by collecting day-level data across years
function computeStreaksFromDateMap(dayMap) {
  // dayMap: { "YYYY-MM-DD": count }
  const dates = Object.keys(dayMap).sort(); // ascending
  if (dates.length === 0) return { total:0, currentStreak:0, longestStreak:0 };

  // build a set of days that have contributionCount > 0
  const have = new Set(dates.filter(d => (dayMap[d] || 0) > 0));

  // longest streak (iterate days between min and max)
  const min = dates[0], max = dates[dates.length - 1];
  const minDate = new Date(min), maxDate = new Date(max);
  let longest = 0;
  let cur = 0;
  let curDate = new Date(minDate);
  while (curDate <= maxDate) {
    const key = curDate.toISOString().slice(0,10);
    if (have.has(key)) {
      cur++;
    } else {
      if (cur > longest) longest = cur;
      cur = 0;
    }
    curDate.setUTCDate(curDate.getUTCDate() + 1);
  }
  if (cur > longest) longest = cur;

  // current streak: count backwards from latest day present (max) until a day with no contributions
  let current = 0;
  let checkDate = new Date(maxDate);
  while (true) {
    const key = checkDate.toISOString().slice(0,10);
    if (have.has(key)) {
      current++;
      checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    } else {
      break;
    }
  }

  // compute total contributions summing dayMap
  const total = Object.values(dayMap).reduce((a,b)=>a+(b||0),0);
  return { total, currentStreak: current, longestStreak: longest };
}

(async () => {
  try {
    // 1) gather per-year contribution days and totals
    const startYear = 2008;
    const currentYear = new Date().getFullYear();
    const dayMap = {}; // map date->count
    let totalCommits = 0, totalPRs = 0, totalReviews = 0, totalIssues = 0, totalPrivate = 0, totalContribs = 0;

    for (let y = startYear; y <= currentYear; y++) {
      const from = `${y}-01-01T00:00:00Z`;
      const to = `${y}-12-31T23:59:59Z`;
      const r = await gqlCall({ login, from, to });
      if (r.error) {
        // skip year if API complains
        continue;
      }
      const col = r.data.user.contributionsCollection;
      totalCommits += col.totalCommitContributions || 0;
      totalPRs += col.totalPullRequestContributions || 0;
      totalReviews += col.totalPullRequestReviewContributions || 0;
      totalIssues += col.totalIssueContributions || 0;
      totalPrivate += col.restrictedContributionsCount || 0;
      const weeks = col.contributionCalendar?.weeks || [];
      for (const w of weeks) {
        for (const d of w.contributionDays || []) {
          // date string like '2023-07-09'
          dayMap[d.date] = (dayMap[d.date] || 0) + (d.contributionCount || 0);
        }
      }
      totalContribs += col.contributionCalendar?.totalContributions || 0;
    }

    // compute streaks
    const { total, currentStreak, longestStreak } = computeStreaksFromDateMap(dayMap);

    // 2) languages: fetch owned repos (limit) and aggregate
    const repos = await fetchOwnedRepos(200);
    const langTotals = await computeLanguageTotals(repos);
    const langEntries = Object.entries(langTotals).sort((a,b)=>b[1]-a[1]);
    const langSum = langEntries.reduce((s,[_l,b])=>s+b,0);
    // keep top 6 languages by bytes
    const topLangs = langEntries.slice(0,6).map(([lang,bytes]) => ({ lang, bytes, pct: langSum ? (bytes/langSum)*100 : 0 }));

    // 3) prepare SVG (simple, clean, matching the sample)
    const width = 920, height = 260;
    const cardX = 20, cardY = 20, cardW = width - 40, cardH = 180;
    const bg = "#0b1220", cardBg = "#0f0f11";
    const titlePink = "#ff9a3c"; // sample used orange — i picked warm orange similar to your screenshot
    const ringAccent = "#ff9a3c";
    const muted = "#9aa6b2";
    const nums = "#ffffff";
    const teal = "#ffd695"; // visible contrast for numbers in this orange design

    // compute ring percent visual (use current streak / longest as relation? We'll show current/longest in center)
    // We'll show ring filled proportionally to currentStreak / (max(current,longest) || 1)
    const ringMax = Math.max(currentStreak, longestStreak, 1);
    const ringPercent = Math.round((currentStreak / ringMax) * 100);
    const radius = 44, ringStroke = 10;
    const rightX = 620, rightY = cardY + 30;
    const cx = rightX + radius, cy = rightY + radius;

    // language bar: horizontal stacked rects
    let langRects = "";
    const barX = cardX + 20, barY = cardY + cardH + 30, barW = cardW - 40, barH = 18;
    let accX = 0;
    for (const t of topLangs) {
      const w = Math.round((t.pct/100) * barW);
      const color = getColorForLang(t.lang);
      langRects += `<rect x="${barX + accX}" y="${barY}" width="${w}" height="${barH}" rx="6" fill="${color}"></rect>`;
      accX += w;
    }
    // labels under the bar, left column list
    const labelItems = topLangs.map((t,i) => {
      const color = getColorForLang(t.lang);
      return `<g transform="translate(${barX + (i*150)}, ${barY + 26})"><rect x="0" y="-10" width="10" height="10" rx="5" fill="${color}"></rect><text x="16" y="0" font-size="12" fill="${muted}" font-family="Segoe UI, Roboto">${esc(t.lang)} ${t.pct.toFixed(1)}%</text></g>`;
    }).join("");

    // helper color by language (simple palette fallback)
    function getColorForLang(name) {
      const map = {
        "JavaScript":"#f1e05a","TypeScript":"#2b7489","HTML":"#e34c26","CSS":"#563d7c","Python":"#3572A5",
        "Dart":"#00B4AB","Java":"#b07219","C++":"#f34b7d","SCSS":"#c6538c","Go":"#00ADD8","Shell":"#89e051"
      };
      return map[name] || "#7a5cff";
    }

    // Build SVG
    const svg = `<?xml version="1.0" encoding="utf-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(login)} stats">
  <rect width="100%" height="100%" fill="${bg}" />
  <g transform="translate(0,0)">
    <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="8" fill="${cardBg}" stroke="#2b2f33" stroke-width="1.5"/>
    <!-- Title -->
    <text x="${cardX + 18}" y="${cardY + 26}" font-family="Segoe UI, Roboto" font-weight="700" font-size="20" fill="${titlePink}">🔥 My Stats :</text>

    <!-- left column: total contributions -->
    <g transform="translate(${cardX + 30}, ${cardY + 48})" font-family="Segoe UI, Roboto">
      <text x="0" y="0" font-size="32" font-weight="800" fill="#ffffff">${nf(total)}</text>
      <text x="0" y="26" font-size="13" fill="${muted}">Total Contributions</text>
      <text x="0" y="46" font-size="12" fill="${muted}">${getFirstContributionDate(dayMap) || "—"} - Present</text>
    </g>

    <!-- center: ring (current streak) -->
    <g transform="translate(${rightX - 150}, ${cardY + 30})">
      <g transform="translate(${150},0)">
        <circle cx="${cx - (rightX-150)}" cy="${cy - (cardY+30)}" r="${radius}" stroke="#2e1d20" stroke-width="${ringStroke}" fill="none"/>
        <g transform="rotate(-90 ${cx - (rightX-150)} ${cy - (cardY+30)})">
          <circle cx="${cx - (rightX-150)}" cy="${cy - (cardY+30)}" r="${radius}" stroke="#3a2832" stroke-width="${ringStroke}" fill="none"/>
          <circle cx="${cx - (rightX-150)}" cy="${cy - (cardY+30)}" r="${radius}" stroke="${ringAccent}" stroke-width="${ringStroke}" fill="none" stroke-linecap="round"
            stroke-dasharray="${(2*Math.PI*radius)*(ringPercent/100)} ${(2*Math.PI*radius)}" />
        </g>
        <text x="${cx - (rightX-150)}" y="${cy - (cardY+30)}" text-anchor="middle" dominant-baseline="central" font-size="28" font-weight="800" fill="#fff">${currentStreak}</text>
        <text x="${cx - (rightX-150)}" y="${cy - (cardY+30) + 34}" text-anchor="middle" font-size="12" fill="${muted}">Current Streak</text>
      </g>
    </g>

    <!-- right: longest streak -->
    <g transform="translate(${rightX + 130}, ${cardY + 48})" font-family="Segoe UI, Roboto">
      <text x="0" y="0" font-size="32" font-weight="800" fill="#ffffff">${longestStreak}</text>
      <text x="0" y="26" font-size="13" fill="${muted}">Longest Streak</text>
      <text x="0" y="46" font-size="12" fill="${muted}">—</text>
    </g>

    <!-- divider line -->
    <line x1="${cardX + leftColWidth}" y1="${cardY + 30}" x2="${cardX + leftColWidth}" y2="${cardY + cardH - 10}" stroke="#212427" stroke-width="1"/>

    <!-- languages bar -->
    ${langRects}
    ${labelItems}

    <!-- bar border -->
    <rect x="${barX - 8}" y="${barY - 8}" width="${barW + 16}" height="${barH + 64}" rx="8" fill="none" stroke="#2b2f33" stroke-width="1"/>
  </g>
</svg>`;

    // write
    const outDir = path.join(process.cwd(), "..", "..", "assets");
    fs.mkdirSync(outDir, { recursive: true });
    const stablePath = path.join(outDir, "stats.svg");
    fs.writeFileSync(stablePath, svg, "utf8");
    const cb = path.join(outDir, `stats-${Date.now()}.svg`);
    fs.writeFileSync(cb, svg, "utf8");

    console.log("Wrote SVG", stablePath);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  // small helper to find first contribution date from dayMap (earliest key)
  function getFirstContributionDate(dayMapObj) {
    const keys = Object.keys(dayMapObj || {});
    if (!keys.length) return null;
    const d = keys.sort()[0];
    // format like "Apr 18, 2016"
    const dt = new Date(d);
    return dt.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
})();
