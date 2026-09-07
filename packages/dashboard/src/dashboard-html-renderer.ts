import type { DashboardData } from './dashboard-data-service.js';

/**
 * Stage 7, Section U — renders `DashboardData` as one simple, static HTML
 * page: plain tables and cards, no JavaScript, no interactivity, no
 * publishing controls of any kind. "Prefer simple tables/cards over
 * complex UI" — this is intentionally that, not a placeholder for a real
 * frontend.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p><em>No data yet.</em></p>';
  const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

export function renderDashboardHtml(data: DashboardData): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Metrivio Content Intelligence Dashboard</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 0.9rem; }
th { background: #f5f5f5; }
.meta { color: #666; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Metrivio Content Intelligence Dashboard</h1>
<p class="meta">Generated ${escapeHtml(data.generatedAt)} — read-only, no publishing controls.</p>

<h2>1. ICP Pain Trends</h2>
${table(['Pain Category', 'Signal Count'], data.icpPainTrends.map((t) => [t.painCategory, String(t.count)]))}

<h2>2. Competitor Themes</h2>
${table(['Pain Category', 'Signal Count', 'Account Count'], data.competitorThemes.map((t) => [t.painCategory, String(t.signalCount), String(t.accountCount)]))}

<h2>3. Expert Themes</h2>
${table(['Pain Category', 'Signal Count'], data.expertThemes.map((t) => [t.painCategory, String(t.count)]))}

<h2>4. Content Opportunities</h2>
${table(['Score', 'Hook', 'Format'], data.contentOpportunities.map((o) => [String(o.score), o.hook, o.recommendedFormat]))}

<h2>5. Metrivio's Own Post Performance</h2>
${table(
  ['Post ID', 'Reach', 'Engagement', 'ICP Engagement', 'Business Intent'],
  data.ownPostPerformance.map((p) => [p.postId, p.reach == null ? 'n/a' : String(p.reach), p.engagement == null ? 'n/a' : String(p.engagement), p.icpEngagement == null ? 'n/a' : String(p.icpEngagement), p.businessIntentSignal])
)}

<h2>6. Best-Performing Topics</h2>
${table(['Pain Category'], data.bestPerformingTopics.map((t) => [t]))}

<h2>7. Best-Performing Hooks</h2>
${table(['Hook Type'], data.bestPerformingHooks.map((h) => [h]))}

<h2>8. Growth Technique Library</h2>
${table(['Technique', 'Category', 'Status', 'Applicability'], data.growthTechniques.map((t) => [t.technique, t.category, t.status, t.applicability]))}

<h2>9. Recommended Next Content</h2>
${table(['Score', 'Hook'], data.recommendedNextContent.map((o) => [String(o.score), o.hook]))}

<h2>10. Publishing Status (Stage 8)</h2>
${table(
  ['Pending Approval', 'Approved (not yet published)', 'Scheduled', 'Due Now', 'Published', 'Failed', 'Unknown'],
  [[
    String(data.publishingStatus.pendingApproval),
    String(data.publishingStatus.approved),
    String(data.publishingStatus.scheduled),
    String(data.publishingStatus.due),
    String(data.publishingStatus.published),
    String(data.publishingStatus.failed),
    String(data.publishingStatus.unknown),
  ]]
)}
<h3>Recent Publishing Activity</h3>
${table(
  ['Draft ID', 'Outcome', 'X Post ID', 'Timestamp'],
  data.publishingStatus.recentActivity.map((a) => [a.draftId, a.outcome, a.xPostId ?? 'n/a', a.timestamp])
)}
</body>
</html>`;
}
