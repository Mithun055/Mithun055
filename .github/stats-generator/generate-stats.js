import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const token = process.env.GH_TOKEN;
const login = process.env.GITHUB_LOGIN || "Mithun055";

if (!token) {
  console.error("GH_TOKEN not provided.");
  process.exit(1);
}

// GraphQL query (1 year max allowed)
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
    header
